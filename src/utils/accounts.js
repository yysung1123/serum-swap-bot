import * as BufferLayout from 'buffer-layout';

import {
    Account,
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
} from '@solana/web3.js';

import bs58 from 'bs58';

import { TokenListProvider, TokenInfo } from '@solana/spl-token-registry';

import { AccountLayout, Token, TOKEN_PROGRAM_ID, MintLayout, u64 } from '@solana/spl-token';

import { programIds } from './ids.js';

import { TokenSwapLayout, TokenSwapLayoutLegacyV0 as TokenSwapLayoutV0, TokenSwapLayoutV1 } from './tokenSwap.js';

import { getHoldingAmounts } from './pools.js';

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

// https://github.com/project-serum/oyster-swap/blob/cff4858523b77a7a9ee105a135b6dee6bbcb4634/src/utils/pools.tsx#L457
const toPoolInfo = (item, program, toMerge) => {
    const mint = new PublicKey(item.data.tokenPool);
    return {
        pubkeys: {
            account: item.pubkey,
            program: program,
            mint,
            holdingMints: [],
            holdingAccounts: [item.data.tokenAccountA, item.data.tokenAccountB].map(
                (a) => new PublicKey(a)
            ),
        },
        legacy: false,
        raw: item,
    };
};

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
    m.set("SOL", publicKey);
    return m;
};

async function getTokens(connection, publicKey) {
    let tokenList = (await new TokenListProvider().resolve()).filterByClusterSlug('mainnet-beta').getList();
    return new Map(tokenList.filter(item => item['name'] != "Tether USD (Wormhole)").map(({ symbol, address }) => {
        return [symbol, new Token(connection, new PublicKey(address), TOKEN_PROGRAM_ID, null)];
    }));
};

async function getTokenNames(connection) {
    let tokens = await getTokens();
    return new Map(Array.from(tokens).map(([symbol, token]) => {
        return [token.publicKey.toString(), symbol];
    }));
}

async function getSwapPools(connection, rateLimiter) {
    // https://github.com/project-serum/oyster-swap/blob/cff4858523b77a7a9ee105a135b6dee6bbcb4634/src/utils/pools.tsx#L482
    const queryPools = async (swapId, isLegacy = false) => {
        let poolsArray = [];
        (await connection.getProgramAccounts(swapId))
            .filter(
                (item) =>
                    item.account.data.length === TokenSwapLayout.span ||
                    item.account.data.length === TokenSwapLayoutV1.span ||
                    item.account.data.length === TokenSwapLayoutV0.span
            )
            .map((item) => {
                let result = {
                    data: undefined,
                    account: item.account,
                    pubkey: item.pubkey,
                    init: async () => { },
                };

                const layout =
                    item.account.data.length === TokenSwapLayout.span
                        ? TokenSwapLayout
                        : item.account.data.length === TokenSwapLayoutV1.span
                            ? TokenSwapLayoutV1
                            : TokenSwapLayoutV0;

                // handling of legacy layout can be removed soon...
                if (layout === TokenSwapLayoutV0) {
                    result.data = layout.decode(item.account.data);
                    let pool = toPoolInfo(result, swapId);
                    pool.legacy = isLegacy;
                    poolsArray.push(pool);

                    result.init = async () => {
                        try {
                            // TODO: this is not great
                            // Ideally SwapLayout stores hash of all the mints to make finding of pool for a pair easier
                            const holdings = await Promise.all(
                                getHoldings(connection, [
                                    result.data.tokenAccountA,
                                    result.data.tokenAccountB,
                                ])
                            );

                            pool.pubkeys.holdingMints = [
                                holdings[0].info.mint,
                                holdings[1].info.mint,
                            ];
                        } catch (err) {
                            console.log(err);
                        }
                    };
                } else {
                    result.data = layout.decode(item.account.data);

                    let pool = toPoolInfo(result, swapId);
                    pool.legacy = isLegacy;
                    pool.pubkeys.feeAccount = new PublicKey(result.data.feeAccount);
                    pool.pubkeys.holdingMints = [
                        new PublicKey(result.data.mintA),
                        new PublicKey(result.data.mintB),
                    ];

                    poolsArray.push(pool);
                }

                return result;
            });

        return poolsArray;
    };

    let pools = await Promise.all([
        queryPools(programIds().swap),
        ...programIds().swap_legacy.map((leg) => queryPools(leg, true)),
    ])
    let pairs = pools[0].map((pool) => {
        const mintAName = cache.getTokenNameByPublicKey(pool.pubkeys.holdingMints[0]);
        const mintBName = cache.getTokenNameByPublicKey(pool.pubkeys.holdingMints[1]);
        const poolName = `${mintAName}/${mintBName}`;
        return [poolName, pool]
    }).filter(item => !item[0].includes('undefined'));
    let pairsWithAmount = await Promise.all(pairs.map(async (item) => {
        const [a, b] = await getHoldingAmounts(connection, rateLimiter, item[1]);
        return [...item, a * b];
    }));
    let m = new Map();
    let mAmount = new Map();
    for (let item of pairsWithAmount) {
        if (m.has(item[0])) {
            if (mAmount[item[0]] < item[2]) {
                m.set(item[0], item[1]);
                mAmount[item[0]] = item[2];
            }
        } else {
            m.set(item[0], item[1]);
            mAmount[item[0]] = item[2];
        }
    }
    return m;
}

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

export const tokenSymbols = ["ETH", "LINK", "SUSHI", "SRM", "FRONT", "YFI", "FTT", "BTC", "TOMO"];
export const stableCoinSymbols = ["USDC", "wUSDT"];

export const cache = {
    initCaches: async (connection, rateLimiter, publicKey) => {
        tokenAccountsCache.clear();
        tokenMintsCache.clear();
        tokenNamesCache.clear();
        swapPoolsCache.clear();
        tokenAccountsCache = await getAccounts(connection, publicKey);
        tokenMintsCache = await getTokens(connection);
        tokenNamesCache = await getTokenNames(connection);
        swapPoolsCache = await getSwapPools(connection, rateLimiter);
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
