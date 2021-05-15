import * as BufferLayout from 'buffer-layout';

import { PublicKey } from '@solana/web3.js';

import bs58 from 'bs58';

import { TokenListProvider } from '@solana/spl-token-registry';

import { TOKEN_PROGRAM_ID, MintLayout, u64 } from '@solana/spl-token';

import serumSwap from './serumSwap.json';

// https://github.com/project-serum/spl-token-wallet/blob/ce8e8cc71bd0a5f48606cc25bc88683ad5421b28/src/utils/tokens/data.js#L4
export const ACCOUNT_LAYOUT = BufferLayout.struct([
    BufferLayout.blob(32, 'mint'),
    BufferLayout.blob(32, 'owner'),
    BufferLayout.nu64('amount'),
    BufferLayout.blob(93),
]);

// https://github.com/project-serum/spl-token-wallet/blob/ce8e8cc71bd0a5f48606cc25bc88683ad5421b28/src/utils/tokens/data.js#L17
export function parseTokenAccountData(data) {
    let { mint, owner, amount } = ACCOUNT_LAYOUT.decode(data);
    return {
        mint: new PublicKey(mint),
        owner: new PublicKey(owner),
        amount,
    };
}

// https://github.com/project-serum/spl-token-wallet/blob/ce8e8cc71bd0a5f48606cc25bc88683ad5421b28/src/utils/tokens/data.js#L31
function getOwnedAccountsFilters(publicKey) {
    return [
        {
            memcmp: {
                offset: ACCOUNT_LAYOUT.offsetOf('owner'),
                bytes: publicKey.toBase58(),
            },
        },
        {
            dataSize: ACCOUNT_LAYOUT.span,
        },
    ];
}

// https://github.com/project-serum/spl-token-wallet/blob/ce8e8cc71bd0a5f48606cc25bc88683ad5421b28/src/utils/tokens/index.js#L27
async function getOwnedTokenAccounts(connection, publicKey) {
    let filters = getOwnedAccountsFilters(publicKey);
    let resp = await connection._rpcRequest('getProgramAccounts', [
        TOKEN_PROGRAM_ID.toBase58(),
        {
            commitment: connection.commitment,
            filters,
        },
    ]);
    if (resp.error) {
        throw new Error(
            'failed to get token accounts owned by ' +
            publicKey.toBase58() +
            ': ' +
            resp.error.message,
        );
    }
    return resp.result
        .map(({ pubkey, account: { data, executable, owner, lamports } }) => ({
            publicKey: new PublicKey(pubkey),
            accountInfo: {
                data: bs58.decode(data),
                executable,
                owner: new PublicKey(owner),
                lamports,
            },
        }))
        .filter(({ accountInfo }) => {
            // TODO: remove this check once mainnet is updated
            return filters.every((filter) => {
                if (filter.dataSize) {
                    return accountInfo.data.length === filter.dataSize;
                } else if (filter.memcmp) {
                    let filterBytes = bs58.decode(filter.memcmp.bytes);
                    return accountInfo.data
                        .slice(
                            filter.memcmp.offset,
                            filter.memcmp.offset + filterBytes.length,
                        )
                        .equals(filterBytes);
                }
                return false;
            });
        });
}

let tokenAccountsCache = new Map();
let tokenMintsCache = new Map();
let tokenNamesCache = new Map();
let swapPoolsCache = new Map();
let mintCache = new Map();
let pendingMintCalls = new Map();
let pendingAccountCalls = new Map();
let genericCache = new Map();

async function getAccounts(connection, publicKey) {
    let tokenAccounts = (await getOwnedTokenAccounts(connection, publicKey)
    )
        .map(({ publicKey, accountInfo }) => {
            return { publicKey, parsed: parseTokenAccountData(accountInfo.data) };
        });
    let tokenList = (await new TokenListProvider().resolve()).filterByClusterSlug('mainnet-beta').getList();
    const m = new Map(tokenAccounts.map(({ publicKey, parsed }) => {
        let symbol = tokenList.find(t => t.address === parsed.mint.toBase58())?.symbol;
        return [symbol, publicKey];
    }));
    return m;
};

const deserializeMint = (data) => {
    if (data.length !== MintLayout.span) {
        throw new Error("Not a valid Mint");
    }

    const mintInfo = MintLayout.decode(data);

    if (mintInfo.mintAuthorityOption === 0) {
        mintInfo.mintAuthority = null;
    } else {
        mintInfo.mintAuthority = new PublicKey(mintInfo.mintAuthority);
    }

    mintInfo.supply = u64.fromBuffer(mintInfo.supply);
    mintInfo.isInitialized = mintInfo.isInitialized !== 0;

    if (mintInfo.freezeAuthorityOption === 0) {
        mintInfo.freezeAuthority = null;
    } else {
        mintInfo.freezeAuthority = new PublicKey(mintInfo.freezeAuthority);
    }

    return mintInfo;
};

const getMintInfo = async (connection, pubKey) => {
    const info = await connection.getAccountInfo(pubKey);
    if (info === null) {
        throw new Error("Failed to find mint account");
    }

    const data = Buffer.from(info.data);

    return deserializeMint(data);
};

export const tokenSymbols = ["ETH", "LINK", "SUSHI", "SRM", "FRONT", "YFI", "FTT", "BTC", "TOMO", "SOL"];
export const stableCoinSymbols = ["USDC", "wUSDT"];

export const cache = {
    initCaches: async (connection, publicKey) => {
        tokenAccountsCache.clear();
        tokenNamesCache.clear();
        swapPoolsCache.clear();
        tokenAccountsCache = await getAccounts(connection, publicKey);
        tokenNamesCache = new Map(Object.entries(serumSwap['tokenNames']));
        swapPoolsCache = new Map(Object.keys(serumSwap['swapPools']).map((key) => {
            const item = serumSwap['swapPools'][key];
            return [key,
                {
                    'pubkeys': {
                        'account': new PublicKey(item.pubkeys.account),
                        'holdingAccounts': [
                            new PublicKey(item.pubkeys.holdingAccounts[0].toString()),
                            new PublicKey(item.pubkeys.holdingAccounts[1].toString()),
                        ],
                        'mint': new PublicKey(item.pubkeys.mint.toString()),
                        'feeAccount': new PublicKey(item.pubkeys.feeAccount.toString()),
                        'program': new PublicKey(item.pubkeys.program.toString()),
                    }
                }
            ]
        }));
    },
    getTokenAccountBySymbol: (symbol) => {
        let account = tokenAccountsCache.get(symbol);
        return account;
    },
    getTokenMintBySymbol: (symbol) => {
        let token = tokenMintsCache.get(symbol);
        return token;
    },
    getTokenNameByPublicKey: (publicKey) => {
        let name = tokenNamesCache.get(publicKey.toString());
        return name;
    },
    getSwapPoolBySymbol: (symbolA, symbolB) => {
        let swapPool = swapPoolsCache.get(`${symbolA}/${symbolB}`);
        return swapPool;
    },
    queryMint: async (connection, pubKey) => {
        let id;
        if (typeof pubKey === "string") {
            id = new PublicKey(pubKey);
        } else {
            id = pubKey;
        }

        const address = id.toBase58();
        let mint = mintCache.get(address);
        if (mint) {
            return mint;
        }

        let query = pendingMintCalls.get(address);
        if (query) {
            return query;
        }

        query = getMintInfo(connection, id).then((data) => {
            pendingAccountCalls.delete(address);

            mintCache.set(address, data);
            return data;
        })
        pendingAccountCalls.set(address, query);

        return query;
    }, get: (pubKey) => {
        let key;
        if (typeof pubKey !== "string") {
            key = pubKey.toBase58();
        } else {
            key = pubKey;
        }

        return genericCache.get(key);
    },
};
