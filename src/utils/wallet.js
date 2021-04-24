import {
    Account,
} from '@solana/web3.js';

import * as bip39 from 'bip39';

import * as nacl from 'tweetnacl';

import { derivePath } from 'ed25519-hd-key';

export function getAccountFromSeed(
    seed
) {
    const path44Change = "m/44'/501'/0'/0'";
    const derivedSeed = derivePath(path44Change, Buffer.from(seed, 'hex')).key;
    return new Account(nacl.sign.keyPair.fromSeed(derivedSeed).secretKey);
}

export function getAccountFromMnemonic(
    mnemonic
) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    return getAccountFromSeed(seed);
}
