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
) {
    let res = 0;
    while (res <= expectation * 0.9) {
        for (;;) {
            try {
                res = parseInt((await connection.getTokenAccountBalance(account, 'confirmed')).value.amount);
                break;
            } catch (e) {
                console.log(e);
            }
        }
        console.log(res, expectation * 0.9);
        await delay(100);
    }
    return res;
}

async function Main() {
    setProgramIds(env)
    for (;;) {
        try {
            await cache.initCaches(connection, owner.publicKey);
            break;
        } catch {

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

    while (true) {
        let tradePairs;
        while (true) {
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
                console.log(e);
            }
        }
        let profit = [];
        const tokenAmount = 80 * (10 ** 6);
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
        if (maxProfit[2] > tokenAmount * 1.005) {
            console.log(maxProfit);
            usdc_balance = await getTokenAccountBalance(connection, usdc_account, tokenAmount);
            console.log(usdc_balance);
            let changedAccount;
            let changedTokenAmount;
            let expectation;
            if (!maxProfit[1]) {
                // usdc -> wusdt -> token -> usdc;
                let token = maxProfit[0];
                expectation = caculateProfit(tokenAmount, [tradePairs.get("USDC/wUSDT")]);
                await swap(connection, owner, tokenAmount, expectation, 0.9, "USDC", "wUSDT");
                changedAccount = await cache.getTokenAccountBySymbol("wUSDT");
                changedTokenAmount = await getTokenAccountBalance(connection, changedAccount, expectation);
                await delay(1000);
                expectation = caculateProfit(changedTokenAmount, [amountSwap(tradePairs.get(`${token}/wUSDT`))]);
                await swap(connection, owner, changedTokenAmount, expectation, 0.8, "wUSDT", token);
                changedAccount = await cache.getTokenAccountBySymbol(token);
                changedTokenAmount = await getTokenAccountBalance(connection, changedAccount, expectation);
                // Wait for blockhash to advance
                await delay(1000);
                expectation = caculateProfit(changedTokenAmount, [tradePairs.get(`${token}/USDC`)]);
                await swap(connection, owner, changedTokenAmount, expectation, 0.8, token, "USDC");
            } else {
                // usdc -> token -> wusdt -> usdc;
                let token = maxProfit[0];
                expectation = caculateProfit(tokenAmount, [amountSwap(tradePairs.get(`${token}/USDC`))]);
                await swap(connection, owner, tokenAmount, expectation, 0.9, "USDC", token);
                changedAccount = await cache.getTokenAccountBySymbol(token);
                changedTokenAmount = await getTokenAccountBalance(connection, changedAccount, expectation);
                // Wait for blockhash to advance
                await delay(1000);
                expectation = caculateProfit(changedTokenAmount, [tradePairs.get(`${token}/wUSDT`)]);
                await swap(connection, owner, changedTokenAmount, expectation, 0.8, token, "wUSDT");
                changedAccount = await cache.getTokenAccountBySymbol("wUSDT");
                changedTokenAmount = await getTokenAccountBalance(connection, changedAccount, expectation);
                // Wait for blockhash to advance
                await delay(1000);
                expectation = caculateProfit(changedTokenAmount, [amountSwap(tradePairs.get("USDC/wUSDT"))])
                await swap(connection, owner, changedTokenAmount, expectation, 0.8, "wUSDT", "USDC");
            }

            usdc_balance = await getTokenAccountBalance(connection, usdc_account, tokenAmount);
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