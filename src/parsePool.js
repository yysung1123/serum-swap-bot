import { Connection, PublicKey } from '@solana/web3.js';

import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { TokenListProvider } from '@solana/spl-token-registry';

import { setProgramIds, programIds } from './utils/ids.js';

import { RateLimiter } from './utils/ratelimiter.js';

import { delay } from './utils/delay.js'

import { TokenSwapLayout, TokenSwapLayoutLegacyV0 as TokenSwapLayoutV0, TokenSwapLayoutV1 } from './utils/tokenSwap.js';

const fs = require('fs')

const env = 'mainnet-beta';
const url = 'https://api.mainnet-beta.solana.com';

const connection = new Connection(url);
const rateLimiter = new RateLimiter(30, 10);

let tokenNamesCache = new Map();
let swapPoolsCache = new Map();

export const getHoldingAmounts = async (
    connection,
    rateLimiter,
    pool,
) => {
    await rateLimiter.wait();
    const holdingA = parseInt((await connection.getTokenAccountBalance(pool.pubkeys.holdingAccounts[0], 'processed')).value.amount);
    await rateLimiter.wait();
    const holdingB = parseInt((await connection.getTokenAccountBalance(pool.pubkeys.holdingAccounts[1], 'processed')).value.amount);
    return [holdingA, holdingB];
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

async function getTokens(connection) {
    let tokenList = (await new TokenListProvider().resolve()).filterByClusterSlug('mainnet-beta').getList();
    return new Map(tokenList.filter(item => item['name'] != "Tether USD (Wormhole)").map(({ symbol, address }) => {
        return [symbol, new Token(connection, new PublicKey(address), TOKEN_PROGRAM_ID, null)];
    }));
};

async function getTokenNames(connection) {
    let tokens = await getTokens(connection);
    return new Map(Array.from(tokens).map(([symbol, token]) => {
        return [token.publicKey.toString(), symbol];
    }));
}

function getTokenNameByPublicKey(publicKey) {
    let name = tokenNamesCache.get(publicKey.toString());
    return name;
}

async function getSwapPools(connection, rateLimiter) {
    // https://github.com/project-serum/oyster-swap/blob/cff4858523b77a7a9ee105a135b6dee6bbcb4634/src/utils/pools.tsx#L482
    const queryPools = async (swapId, rateLimiter, isLegacy = false) => {
        let poolsArray = [];
        await rateLimiter.wait();
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
        queryPools(programIds().swap, rateLimiter),
        ...programIds().swap_legacy.map((leg) => queryPools(leg, rateLimiter, true)),
    ])
    let pairs = pools[0].map((pool) => {
        const mintAName = getTokenNameByPublicKey(pool.pubkeys.holdingMints[0]);
        const mintBName = getTokenNameByPublicKey(pool.pubkeys.holdingMints[1]);
        const poolName = `${mintAName}/${mintBName}`;
        return [poolName, pool]
    }).filter(item => !item[0].includes('undefined'));
    let pairsWithAmount = await Promise.all(pairs.map(async (item) => {
        let a, b;
        for (;;) {
            try {
                [a, b] = await getHoldingAmounts(connection, rateLimiter, item[1]);
                break;
            } catch (e) {
            }
        }
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

async function parsePool(connection, rateLimiter) {
    tokenNamesCache.clear();
    swapPoolsCache.clear();
    tokenNamesCache = await getTokenNames(connection);
    swapPoolsCache = await getSwapPools(connection, rateLimiter);
    return [tokenNamesCache, swapPoolsCache]
}

async function Main() {
    setProgramIds(env);
    const [tokenNames, swapPools] = await parsePool(connection, rateLimiter);
    const swapPoolsData = new Map();
    swapPools.forEach((item, key) => {
        swapPoolsData.set(key, {
            'pubkeys': {
                'account': item.pubkeys.account.toString(),
                'holdingAccounts': [
                    item.pubkeys.holdingAccounts[0].toString(),
                    item.pubkeys.holdingAccounts[1].toString(),
                ],
                'mint': item.pubkeys.mint.toString(),
                'feeAccount': item.pubkeys.feeAccount.toString(),
                'program': item.pubkeys.program.toString(),

            }
        });
    });
    const serumSwap = {
        'tokenNames': Object.fromEntries(tokenNames),
        'swapPools': Object.fromEntries(swapPoolsData),
    };

    fs.writeFileSync('src/utils/serumSwap.json', JSON.stringify(serumSwap));
}

Main();