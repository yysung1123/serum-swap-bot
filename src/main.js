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

const TelegramBot = require('node-telegram-bot-api');

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
    slot_id,
    commitment = 'confirmed',
) {
    let amount = 0;
    let current_slot_id = -1;
    while (current_slot_id < slot_id) {
        for (;;) {
            try {
                const res = await connection.getTokenAccountBalance(account, commitment);
                amount = parseInt(res.value.amount);
                current_slot_id = res.context.slot;
                break;
            } catch (e) {
                console.log(e);
            }
        }
        process.stdout.write(`${amount} ${current_slot_id} ${slot_id}\r`);
        await delay(400);
    }
    console.log(amount);
    return [amount, current_slot_id];
}

async function calcAmountAndSwap(
    connection,
    owner,
    tokenA,
    tokenB,
    rev,
    tokenAAmount,
    tradePairs,
    slot_id,
) {
    let tokenBAmount;
    const pair = tradePairs.get(`${tokenA}/${tokenB}`);
    if (rev) {
        [tokenA, tokenB] = [tokenB, tokenA];
    }
    for (;;) {
        try {
            const tokenBExpectationAmount = caculateProfit(tokenAAmount, (!rev ? [pair] : [amountSwap(pair)]));
            [tokenBAmount, slot_id] = await swap(connection, owner, tokenAAmount, tokenBExpectationAmount, 0.9, tokenA, tokenB);
            break;
        } catch (e) {
            console.log(e);
            await delay(400);
        }
        retry_count += 1;
    }
    return [tokenBAmount, slot_id];
}

async function sendMessage(
    bot,
    chatId,
    text,
) {
    if (bot != null && chatId != null) {
        await bot.sendMessage(chatId, text).catch()
    }
}

async function Main() {
    let bot = null;
    let chatId = null;
    if (process.env.TOKEN != null && process.env.CHAT_ID != null) {
        bot = new TelegramBot(process.env.TOKEN);
        chatId = process.env.CHAT_ID;
    }

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
    let slot_id = 0;
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
            console.log(new Date().toLocaleString());
            [usdc_balance, slot_id] = await getTokenAccountBalance(connection, usdc_account, slot_id);
            console.log(usdc_balance);
            sendMessage(bot, chatId, `${maxProfit}\n${usdc_balance / 1000000}`);
            let swappedAmount;
            let token = maxProfit[0];
            if (!maxProfit[1]) {
                // usdc -> wusdt -> token -> usdc;
                [swappedAmount, slot_id] = await calcAmountAndSwap(connection, owner, "USDC", "wUSDT", false, tokenAmount, tradePairs, slot_id);
                [swappedAmount, slot_id] = await calcAmountAndSwap(connection, owner, token, "wUSDT", true, swappedAmount, tradePairs, slot_id);
                [swappedAmount, slot_id] = await calcAmountAndSwap(connection, owner, token, "USDC", false, swappedAmount, tradePairs, slot_id);
            } else {
                // usdc -> token -> wusdt -> usdc;
                [swappedAmount, slot_id] = await calcAmountAndSwap(connection, owner, token, "USDC", true, tokenAmount, tradePairs, slot_id);
                [swappedAmount, slot_id] = await calcAmountAndSwap(connection, owner, token, "wUSDT", false, swappedAmount, tradePairs, slot_id);
                [swappedAmount, slot_id] = await calcAmountAndSwap(connection, owner, "USDC", "wUSDT", true, swappedAmount, tradePairs, slot_id);
            }

            console.log(swappedAmount);
            console.log(new Date().toLocaleString());
            sendMessage(bot, chatId, `Profit: ${(swappedAmount - usdc_balance) / 1000000}`);
            usdc_balance = swappedAmount;
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