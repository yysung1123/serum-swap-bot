import {
    Transaction,
} from "@solana/web3.js";

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
    /*
    transaction.setSigners(
      // fee payied by the wallet owner
      wallet.publicKey,
      ...signers.map((s) => s.publicKey)
    );
    */
    transaction.sign(wallet);
    if (signers.length > 0) {
      transaction.partialSign(...signers);
    }
    //transaction = await wallet.signTransaction(transaction);
    const rawTransaction = transaction.serialize();
    let options = {
      skipPreflight: true,
      commitment: "confirmed",
    };

    const txid = await connection.sendRawTransaction(rawTransaction, options);

    if (awaitConfirmation) {
      const status = (
        await connection.confirmTransaction(txid, options && options.commitment)
      ).value;

      if (status.err) {

        throw new Error(
          `Raw transaction ${txid} failed (${JSON.stringify(status)})`
        );
      }
    }

    return txid;
  };