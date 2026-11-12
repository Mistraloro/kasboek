import { useCallback, useEffect, useState } from 'react'
import type { OpInput, OpName, OpOutput } from '@shared/contract'

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** Runs an operation in the main process. Throws ApiError on failure. */
export async function call<K extends OpName>(op: K, ...args: {} extends OpInput<K> ? [OpInput<K>?] : [OpInput<K>]): Promise<OpOutput<K>> {
  const res = await window.kasboek.invoke(op, (args[0] ?? {}) as OpInput<K>)
  if (!res.ok) throw new ApiError(res.error.code, res.error.message)
  return res.data
}

/** Loads an operation's result for a component, with a `reload` to refresh it. */
export function useOp<K extends OpName>(op: K, input?: OpInput<K>) {
  const [data, setData] = useState<OpOutput<K> | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const key = JSON.stringify(input ?? {})

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await window.kasboek.invoke(op, JSON.parse(key)).then((r) => {
        if (!r.ok) throw new ApiError(r.error.code, r.error.message)
        return r.data
      }))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('unknown', String(e)))
    } finally {
      setLoading(false)
    }
  }, [op, key])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload }
}
