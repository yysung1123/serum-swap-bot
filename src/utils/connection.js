import {
    Transaction,
} from "@solana/web3.js";

import { delay } from './delay.js'

const MS_PER_SLOT = 400;

async function confirmTransaction (
  connection,
  signature,
  confirmations,
) {
  const start = Date.now();
  const WAIT_TIMEOUT_MS = 60 * 1000;

  let statusResponse = await connection.getSignatureStatus(signature);
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

    // Sleep for approximately one slot
    await delay(MS_PER_SLOT);
    statusResponse = await this.getSignatureStatus(signature);
  }

  return statusResponse;
}

// https://github.com/project-serum/oyster-swap/blob/7966c69c60c27b2c2f1346161ef993a3625e5982/src/utils/connection.tsx#L145
export const sendTransaction = async (
    connection,
    wallet,
    instructions,
    signers,
    awaitConfirmation = false
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
      const status = (
        await confirmTransaction(connection, txid, options && options.commitment)
      ).value;

      if (status.err) {

        throw new Error(
          `Raw transaction ${txid} failed (${JSON.stringify(status)})`
        );
      }
    }

    return txid;
  };