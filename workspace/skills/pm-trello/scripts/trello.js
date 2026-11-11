// Stub: pm-trello not configured for this instance (JIRA-only setup)
module.exports = {
  trelloWorkload: async () => ({ error: 'Trello not configured' }),
  buildConfig: () => ({}),
  getBoardLists: async () => [],
  getBoardCustomFields: async () => [],
  getBoardCards: async () => [],
  normalizeCard: (card) => card
};
