import {
    Transaction,
} from "@solana/web3.js";

import { delay } from './delay.js'

const MS_PER_SLOT = 400;

async function confirmTransaction(
    connection,
    signature,
    confirmations,
) {
    const start = Date.now();
    const WAIT_TIMEOUT_MS = 10 * 1000;

    let statusResponse = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    for (;;) {
        const status = statusResponse.value;
        if (status) {
            // 'status.confirmations === null' implies that the tx has been finalized
            if (
                status.err ||
                status.confirmations === null ||
                (typeof confirmations === 'number' &&
                    status.confirmations >= confirmations)
            ) {
                break;
            }
        } else if (Date.now() - start >= WAIT_TIMEOUT_MS) {
            break;
        }

        await delay(MS_PER_SLOT);
        statusResponse = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    }

    return statusResponse;
}

// https://github.com/project-serum/oyster-swap/blob/7966c69c60c27b2c2f1346161ef993a3625e5982/src/utils/connection.tsx#L145
export const sendTransaction = async (
    connection,
    wallet,
    instructions,
    signers,
    awaitConfirmation = true
) => {
    let transaction = new Transaction();
    instructions.forEach((instruction) => transaction.add(instruction));
    transaction.recentBlockhash = (
        await connection.getRecentBlockhash("max")
    ).blockhash;
    transaction.sign(wallet);
    if (signers.length > 0) {
        transaction.partialSign(...signers);
    }
    const rawTransaction = transaction.serialize();

    let options = {
        skipPreflight: true,
        commitment: "confirmed",
    };

    const txid = await connection.sendRawTransaction(rawTransaction, options);

    if (awaitConfirmation) {
        //await connection.getConfirmedTransaction(txid, options && options.commitment);
        let res, status, status_null_count = 0;
        for (;;) {
            try {
                res = await confirmTransaction(connection, txid, 2);
                status = res.value;
                if (status === null && status_null_count < 2) {
                    console.log(`status null ${status_null_count}`);
                    status_null_count += 1;
                    continue;
                }
                break;
            } catch (e) {
                //console.log(e);
            }
        }

        console.log(res);
        if (status === null || status.err) {

            throw new Error(
                `Raw transaction ${txid} failed (${JSON.stringify(status)})`
            );
        }
    }

    return txid;
};