import {
    Account,
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
} from '@solana/web3.js';

import { getAccountFromMnemonic } from './utils/wallet.js'

import { cache, tokenSymbols } from './utils/accounts.js';

import { setProgramIds } from './utils/ids.js';

import { swap, getHoldingAmounts } from './utils/pools.js';

import { delay } from './utils/delay.js';

require('dotenv').config();

const env = 'mainnet-beta';
const url = 'https://api.mainnet-beta.solana.com';
const mnemonic = process.env.MNEMONIC;
const tokenAmount = parseInt(process.env.USDC_AMOUNT) * 1000000;
const minimumProfit = parseFloat(process.env.MINIMUM_PROFIT);

const connection = new Connection(url);

const owner = getAccountFromMnemonic(mnemonic);

function amountSwap(
    [a, b]
) {
    return [b, a];
}

function caculateProfit(
    tokenAmount,
    amounts,
    fee = 0.3 / 100,
) {
    for (let amount of amounts) {
        tokenAmount = Math.floor(tokenAmount * (1 - fee));
        const invariant = amount[0] * amount[1];
        tokenAmount = Math.floor(amount[1] - invariant / (amount[0] + tokenAmount));
    }
    return tokenAmount;
}

async function getTokenAccountBalance(
    connection,
    account,
    expectation = 0,
    commitment = 'confirmed',
) {
    let res = 0;
    while (res <= expectation * 0.9) {
        for (;;) {
            try {
                res = parseInt((await connection.getTokenAccountBalance(account, commitment)).value.amount);
                break;
            } catch (e) {
                console.log(e);
            }
        }
        process.stdout.write(`${res} ${expectation * 0.9}\r`);
        await delay(100);
    }
    console.log(res, expectation * 0.9);
    return res;
}

async function calcAmountAndSwap(
    connection,
    owner,
    tokenA,
    tokenB,
    rev,
    tokenAExpectationAmount,
    tradePairs,
    tokenAAmountLimit = 0,
) {
    let tokenBExpectationAmount = 0;
    let tokenBAmount = 0;
    const pair = tradePairs.get(`${tokenA}/${tokenB}`);
    if (rev) {
        [tokenA, tokenB] = [tokenB, tokenA];
    }
    const tokenAAccount = await cache.getTokenAccountBySymbol(tokenA);
    const tokenBAccount = await cache.getTokenAccountBySymbol(tokenB);
    for (;;) {
        try {
            let tokenAAmount = await getTokenAccountBalance(connection, tokenAAccount, tokenAExpectationAmount);
            if (tokenAAmountLimit > 0) {
                tokenAAmount = Math.min(tokenAAmount, tokenAAmountLimit);
            }
            await delay(400);
            tokenBExpectationAmount = 0;
            tokenBExpectationAmount = caculateProfit(tokenAAmount, (!rev ? [pair] : [amountSwap(pair)]));
            await swap(connection, owner, tokenAAmount, tokenBExpectationAmount, 0.9, tokenA, tokenB);
            tokenBAmount = await getTokenAccountBalance(connection, tokenBAccount, tokenBExpectationAmount);
            break;
        } catch (e) {
            console.log(e);
            await delay(1000);
            /*
            tokenBAmount = await getTokenAccountBalance(connection, tokenBAccount, 1);
            // Transaction success
            if (tokenBAmount >= tokenBExpectationAmount * 0.9) {
                break;
            }
            */
        }
    }
    return tokenBAmount;
}

async function Main() {
    setProgramIds(env)
    for (;;) {
        try {
            await cache.initCaches(connection, owner.publicKey);
            break;
        } catch (e) {
            console.log(e);
        }
    }
    /*
    const balance = await connection.getBalance(owner.publicKey);
    console.log(balance);


    let usdc_balance = parseInt((await connection.getTokenAccountBalance(usdc_account)).value.amount);
    console.log(usdc_balance);
    let usdc_wusdt = await cache.getSwapPoolBySymbol("ETH", "USDC");
    console.log(usdc_wusdt.pubkeys.account.toString());

    const amountIn = 0.1;
    const minAmountOut = 0.1 * 0.995;

    const amounts = await getHoldingAmounts(connection, usdc_wusdt);
    console.log(amounts);
    */
    let usdc_account = await cache.getTokenAccountBySymbol("USDC");
    let usdc_balance;
    const reserved_sol_balance = 10000000;

    while (true) {
        let tradePairs;
        for (;;) {
            try {
                let usdcPairs = await Promise.all(tokenSymbols.map(async (item) => {
                    const pool = await cache.getSwapPoolBySymbol(item, "USDC");
                    const [a, b] = await getHoldingAmounts(connection, pool);
                    return [`${item}/USDC`, [a, b]];
                }));
                let wusdtPairs = await Promise.all(tokenSymbols.map(async (item) => {
                    const pool = await cache.getSwapPoolBySymbol(item, "wUSDT");
                    const amounts = await getHoldingAmounts(connection, pool);
                    return [`${item}/wUSDT`, amounts];
                }));
                wusdtPairs.push(["USDC/wUSDT", await getHoldingAmounts(connection, await cache.getSwapPoolBySymbol("USDC", "wUSDT"))]);
                tradePairs = new Map(usdcPairs.concat(wusdtPairs));
                break;
            } catch (e) {
                // console.log(e);
            }
        }
        let profit = [];
        for (let token of tokenSymbols) {
            // usdc -> wusdt -> token -> usdc;
            let amounts = []
            amounts.push(tradePairs.get("USDC/wUSDT"));
            amounts.push(amountSwap(tradePairs.get(`${token}/wUSDT`)));
            amounts.push(tradePairs.get(`${token}/USDC`));
            profit.push([token, false, caculateProfit(tokenAmount, amounts)]);

            // usdc -> token -> wusdt -> usdc;
            amounts = []
            amounts.push(amountSwap(tradePairs.get(`${token}/USDC`)));
            amounts.push(tradePairs.get(`${token}/wUSDT`));
            amounts.push(amountSwap(tradePairs.get("USDC/wUSDT")));
            profit.push([token, true, caculateProfit(tokenAmount, amounts)]);
        }
        const maxProfit = profit.reduce(function(prev, current) {
            return (prev[2] > current[2]) ? prev : current
        })
        if (maxProfit[2] > tokenAmount * minimumProfit) {
            console.log(maxProfit);
            usdc_balance = await getTokenAccountBalance(connection, usdc_account, usdc_balance);
            console.log(usdc_balance);
            const usdcAmountCheck = usdc_balance - tokenAmount;
            let expectation;
            if (!maxProfit[1]) {
                // usdc -> wusdt -> token -> usdc;
                let token = maxProfit[0];
                expectation = await calcAmountAndSwap(connection, owner, "USDC", "wUSDT", false, tokenAmount, tradePairs, tokenAmount);
                expectation = await calcAmountAndSwap(connection, owner, token, "wUSDT", true, expectation, tradePairs);
                expectation = await calcAmountAndSwap(connection, owner, token, "USDC", false, expectation, tradePairs);
            } else {
                // usdc -> token -> wusdt -> usdc;
                let token = maxProfit[0];
                expectation = await calcAmountAndSwap(connection, owner, token, "USDC", true, tokenAmount, tradePairs, tokenAmount);
                expectation = await calcAmountAndSwap(connection, owner, token, "wUSDT", false, expectation, tradePairs);
                expectation = await calcAmountAndSwap(connection, owner, "USDC", "wUSDT", true, expectation, tradePairs);
            }

            usdc_balance = await getTokenAccountBalance(connection, usdc_account, usdc_balance);
            console.log(usdc_balance);
        } else {
            console.log("sleep start");
            await delay(2 * 1000);
            console.log("sleep end");
        }
    }
    // await swap(connection, owner, 100, 98, 0.995, "USDC", "wUSDT");
    //cleanupInstructions.push(Token.createRevokeInstruction(usdc_mint.programId, usdc_account, owner.publicKey, []));
    //console.log(instructions);
    //let tx = await sendTransaction(connection, owner, instructions.concat(cleanupInstructions), []);
    //console.log(tx);
}

Main()