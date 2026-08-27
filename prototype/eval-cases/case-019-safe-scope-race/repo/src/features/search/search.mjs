export function createSearch(fetcher) {
  const state = { query: '', results: [] };
  return {
    issue(query) {
      state.query = query;
      return fetcher(query).then((results) => {
        state.results = results;
      });
    },
    current() {
      return { query: state.query, results: state.results };
    },
  };
}
