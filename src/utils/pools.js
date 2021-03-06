import { TokenSwapLayout, swapInstruction } from './tokenSwap.js';

import { cache } from './accounts.js';

import { sendTransaction } from './connection.js';

import { programIds } from './ids.js';

import { Account } from '@solana/web3.js';

import { Token } from '@solana/spl-token';

import { delay } from './delay.js';

export const isLatest = (swap) => {
    return swap.data.length === TokenSwapLayout.span;
};

function approveAmount(
    instructions,
    cleanupInstructions,
    account,
    owner,
    amount,

    // if delegate is not passed ephemeral transfer authority is used
    delegate
) {
    const tokenProgram = programIds().token;
    const transferAuthority = new Account();

    instructions.push(
        Token.createApproveInstruction(
            tokenProgram,
            account,
            delegate ?? transferAuthority.publicKey,
            owner,
            [],
            amount
        )
    );

    cleanupInstructions.push(
        Token.createRevokeInstruction(tokenProgram, account, owner, [])
    );

    return transferAuthority;
}

export const swap = async (
    connection,
    wallet,
    amountIn,
    amountOut,
    SLIPPAGE,
    mintAName,
    mintBName,
) => {
    let reverse = false;
    let queryMintAName, queryMintBName;
    if (mintAName == "wUSDT") {
        reverse = true;
        [queryMintAName, queryMintBName] = [mintBName, mintAName];
    } else if (mintAName == "USDC" && mintBName != "wUSDT") {
        reverse = true;
        [queryMintAName, queryMintBName] = [mintBName, mintAName];
    } else {
        [queryMintAName, queryMintBName] = [mintAName, mintBName];
    }
    console.log(mintAName, mintBName);
    const pool = cache.getSwapPoolBySymbol(queryMintAName, queryMintBName);

    const minAmountOut = Math.floor(amountOut * SLIPPAGE);
    const holdingA = !reverse ? pool.pubkeys.holdingAccounts[0] : pool.pubkeys.holdingAccounts[1];
    const holdingB = !reverse ? pool.pubkeys.holdingAccounts[1] : pool.pubkeys.holdingAccounts[0];
    const poolMint = await cache.queryMint(connection, pool.pubkeys.mint);
    if (!poolMint.mintAuthority || !pool.pubkeys.feeAccount) {
        throw new Error("Mint doesnt have authority");
    }
    const authority = poolMint.mintAuthority;

    const instructions = [];
    const cleanupInstructions = [];
    const signers = [];

    const fromAccount = await cache.getTokenAccountBySymbol(mintAName);
    const toAccount = await cache.getTokenAccountBySymbol(mintBName);

    const isLatestSwap = true;
    const transferAuthority = approveAmount(
        instructions,
        cleanupInstructions,
        fromAccount,
        wallet.publicKey,
        amountIn,
        isLatestSwap ? undefined : authority
    );
    if (isLatestSwap) {
        signers.push(transferAuthority);
    }

    let hostFeeAccount = undefined;

    instructions.push(
        swapInstruction(
            pool.pubkeys.account,
            authority,
            transferAuthority.publicKey,
            fromAccount,
            holdingA,
            holdingB,
            toAccount,
            pool.pubkeys.mint,
            pool.pubkeys.feeAccount,
            pool.pubkeys.program,
            programIds().token,
            amountIn,
            minAmountOut,
            hostFeeAccount,
            isLatestSwap
        )
    );

    let tx = await sendTransaction(
        connection,
        wallet,
        instructions.concat(cleanupInstructions),
        signers,
    );

    let res;
    for (;;) {
        try {
            res = await connection.getConfirmedTransaction(tx, "confirmed");
            if (res !== null) {
                break;
            }
        } catch (e) {
        }
        await delay(200);
    }

    const tokenBAmount = parseInt(res.meta.postTokenBalances[3].uiTokenAmount.amount);
    const slot_id = res.slot;
    return [tokenBAmount, slot_id];
}