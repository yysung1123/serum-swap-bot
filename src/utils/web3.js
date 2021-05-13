import assert from 'assert'
import { PublicKey } from '@solana/web3.js'
/*
import { struct } from 'superstruct'

function jsonRpcResult(resultDescription) {
  const jsonRpcVersion = struct.literal('2.0')
  return struct.union([
    struct({
      jsonrpc: jsonRpcVersion,
      id: 'string',
      error: 'any'
    }),
    struct({
      jsonrpc: jsonRpcVersion,
      id: 'string',
      error: 'null?',
      result: resultDescription
    })
  ])
}

function jsonRpcResultAndContext(resultDescription) {
  return jsonRpcResult({
    context: struct({
      slot: 'number'
    }),
    value: resultDescription
  })
}

const GetMultipleAccountsAndContextRpcResult = jsonRpcResultAndContext(
  struct.array([struct.union(['null', AccountInfoResult])])
)
*/

export async function getMultipleAccounts(
  connection,
  publicKeys,
  commitment
) {
  const keys = []
  let tempKeys = []

  publicKeys.forEach((k) => {
    if (tempKeys.length >= 100) {
      keys.push(tempKeys)
      tempKeys = []
    }
    tempKeys.push(k.toBase58())
  })
  if (tempKeys.length > 0) {
    keys.push(tempKeys)
  }

  const accounts = []

  for (const key of keys) {
    const args = [key, { commitment }]

    // @ts-ignore
    const unsafeRes = await connection._rpcRequest('getMultipleAccounts', args)
    //const res = GetMultipleAccountsAndContextRpcResult(unsafeRes)
    const res = unsafeRes
    if (res.error) {
      throw new Error(
        'failed to get info about accounts ' + publicKeys.map((k) => k.toBase58()).join(', ') + ': ' + res.error.message
      )
    }

    assert(typeof res.result !== 'undefined')

    for (const account of res.result.value) {
      let value = null
      if (account === null) {
        accounts.push(null)
        continue
      }
      if (res.result.value) {
        const { executable, owner, lamports, data } = account
        assert(data[1] === 'base64')
        value = {
          executable,
          owner: new PublicKey(owner),
          lamports,
          data: Buffer.from(data[0], 'base64')
        }
      }
      if (value === null) {
        throw new Error('Invalid response')
      }
      accounts.push(value)
    }
  }

  return accounts.map((account, idx) => {
    if (account === null) {
      return null
    }
    return {
      publicKey: publicKeys[idx],
      account
    }
  })
}