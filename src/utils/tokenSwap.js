import * as BufferLayout from 'buffer-layout';

import { PublicKey, Account, TransactionInstruction } from "@solana/web3.js";

import { Numberu64 } from "@solana/spl-token-swap";


// https://github.com/project-serum/oyster-swap/blob/cff4858523b77a7a9ee105a135b6dee6bbcb4634/src/models/tokenSwap.ts
export const publicKey = (property = "publicKey") => {
    return BufferLayout.blob(32, property);
};

export const uint64 = (property = "uint64") => {
    return BufferLayout.blob(8, property);
};

const FEE_LAYOUT = BufferLayout.struct(
    [
        BufferLayout.nu64("tradeFeeNumerator"),
        BufferLayout.nu64("tradeFeeDenominator"),
        BufferLayout.nu64("ownerTradeFeeNumerator"),
        BufferLayout.nu64("ownerTradeFeeDenominator"),
        BufferLayout.nu64("ownerWithdrawFeeNumerator"),
        BufferLayout.nu64("ownerWithdrawFeeDenominator"),
        BufferLayout.nu64("hostFeeNumerator"),
        BufferLayout.nu64("hostFeeDenominator"),
    ],
    "fees"
);


export const TokenSwapLayoutLegacyV0 = BufferLayout.struct([
    BufferLayout.u8("isInitialized"),
    BufferLayout.u8("nonce"),
    publicKey("tokenAccountA"),
    publicKey("tokenAccountB"),
    publicKey("tokenPool"),
    uint64("feesNumerator"),
    uint64("feesDenominator"),
]);

const CURVE_NODE = BufferLayout.union(
    BufferLayout.u8(),
    BufferLayout.blob(32),
    "curve"
);
CURVE_NODE.addVariant(0, BufferLayout.struct([]), "constantProduct");
CURVE_NODE.addVariant(
    1,
    BufferLayout.struct([BufferLayout.nu64("token_b_price")]),
    "constantPrice"
);
CURVE_NODE.addVariant(2, BufferLayout.struct([]), "stable");
CURVE_NODE.addVariant(
    3,
    BufferLayout.struct([BufferLayout.nu64("token_b_offset")]),
    "offset"
);

export const TokenSwapLayout = BufferLayout.struct(
    [
        BufferLayout.u8("version"),
        BufferLayout.u8("isInitialized"),
        BufferLayout.u8("nonce"),
        publicKey("tokenProgramId"),
        publicKey("tokenAccountA"),
        publicKey("tokenAccountB"),
        publicKey("tokenPool"),
        publicKey("mintA"),
        publicKey("mintB"),
        publicKey("feeAccount"),
        FEE_LAYOUT,
        CURVE_NODE,
    ]
);

export const TokenSwapLayoutV1 = BufferLayout.struct(
    [
        BufferLayout.u8("isInitialized"),
        BufferLayout.u8("nonce"),
        publicKey("tokenProgramId"),
        publicKey("tokenAccountA"),
        publicKey("tokenAccountB"),
        publicKey("tokenPool"),
        publicKey("mintA"),
        publicKey("mintB"),
        publicKey("feeAccount"),
        BufferLayout.u8("curveType"),
        uint64("tradeFeeNumerator"),
        uint64("tradeFeeDenominator"),
        uint64("ownerTradeFeeNumerator"),
        uint64("ownerTradeFeeDenominator"),
        uint64("ownerWithdrawFeeNumerator"),
        uint64("ownerWithdrawFeeDenominator"),
        BufferLayout.blob(16, "padding"),
    ]
);

export const swapInstruction = (
    tokenSwap,
    authority,
    transferAuthority,
    userSource,
    poolSource,
    poolDestination,
    userDestination,
    poolMint,
    feeAccount,
    swapProgramId,
    tokenProgramId,
    amountIn,
    minimumAmountOut,
    programOwner,
    isLatest
) => {
    const dataLayout = BufferLayout.struct([
        BufferLayout.u8("instruction"),
        uint64("amountIn"),
        uint64("minimumAmountOut"),
    ]);

    const keys = isLatest
        ? [
            { pubkey: tokenSwap, isSigner: false, isWritable: false },
            { pubkey: authority, isSigner: false, isWritable: false },
            { pubkey: transferAuthority, isSigner: true, isWritable: false },
            { pubkey: userSource, isSigner: false, isWritable: true },
            { pubkey: poolSource, isSigner: false, isWritable: true },
            { pubkey: poolDestination, isSigner: false, isWritable: true },
            { pubkey: userDestination, isSigner: false, isWritable: true },
            { pubkey: poolMint, isSigner: false, isWritable: true },
            { pubkey: feeAccount, isSigner: false, isWritable: true },
            { pubkey: tokenProgramId, isSigner: false, isWritable: false },
        ]
        : [
            { pubkey: tokenSwap, isSigner: false, isWritable: false },
            { pubkey: authority, isSigner: false, isWritable: false },
            { pubkey: userSource, isSigner: false, isWritable: true },
            { pubkey: poolSource, isSigner: false, isWritable: true },
            { pubkey: poolDestination, isSigner: false, isWritable: true },
            { pubkey: userDestination, isSigner: false, isWritable: true },
            { pubkey: poolMint, isSigner: false, isWritable: true },
            { pubkey: feeAccount, isSigner: false, isWritable: true },
            { pubkey: tokenProgramId, isSigner: false, isWritable: false },
        ];

    // optional depending on the build of token-swap program
    if (programOwner) {
        keys.push({ pubkey: programOwner, isSigner: false, isWritable: true });
    }

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
        {
            instruction: 1, // Swap instruction
            amountIn: new Numberu64(amountIn).toBuffer(),
            minimumAmountOut: new Numberu64(minimumAmountOut).toBuffer(),
        },
        data
    );

    return new TransactionInstruction({
        keys,
        programId: swapProgramId,
        data,
    });
};