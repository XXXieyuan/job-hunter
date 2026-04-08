/**
 * Sanitize user search input for safe FTS5 MATCH queries.
 * Wraps each token in double quotes to force literal matching.
 * Falls back to null if input is empty after sanitization.
 *
 * @param {string} rawInput - Raw user search string
 * @returns {string|null} Sanitized FTS5 query, or null if empty
 */
function sanitizeFtsQuery(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;

  // Strip FTS5 special syntax characters
  const cleaned = rawInput
    .replace(/[*"{}()^~:;'=\-\\]/g, '') // remove FTS5 operators + SQL-significant chars
    .replace(/\b(AND|OR|NOT|NEAR|DROP|TABLE|SELECT|INSERT|DELETE|UPDATE|UNION|ALTER|CREATE)\b/gi, '') // remove boolean operators + SQL keywords
    .trim();

  if (!cleaned) return null;

  // Wrap each word in double quotes for literal matching
  const terms = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return null;

  return terms.map((t) => `"${t}"`).join(' ');
}

module.exports = {
  sanitizeFtsQuery,
};
