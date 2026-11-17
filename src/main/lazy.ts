/**
 * Loads a module the first time it is needed (a dynamic import), so it does not slow the start.
 * `get()` loads once, also when called twice at the same time, and tries again after a failure.
 * `loaded()` is the module only when it has been loaded already: code that has nothing to do unless
 * the module was used (cancelling a running job, say) calls that instead and never loads it.
 */
export interface Lazy<T> {
  get(): Promise<T>
  loaded(): T | null
}

export function lazy<T>(load: () => Promise<T>): Lazy<T> {
  let module: T | null = null
  let loading: Promise<T> | null = null
  return {
    get() {
      loading ??= load().then(
        (m) => (module = m),
        (err: unknown) => {
          loading = null
          throw err
        }
      )
      return loading
    },
    loaded: () => module
  }
}
