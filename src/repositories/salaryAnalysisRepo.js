'use strict';

const { getDb } = require('../db/connection');

/**
 * Whitelist of allowed group_by columns.
 * Maps API parameter values to actual column names.
 */
const GROUP_BY_WHITELIST = {
  location: 'location',
  source: 'source',
  aps_classification: 'aps_classification',
};

/**
 * APS classification hierarchy for sorting.
 */
const APS_HIERARCHY = ['APS3', 'APS4', 'APS5', 'APS6', 'EL1', 'EL2', 'SES'];

const OUTLIER_MIN = 20000;
const OUTLIER_MAX = 500000;
const ROW_CAP = 10000;

/**
 * Compute a percentile value using linear interpolation.
 * @param {number[]} sorted - Sorted array of numbers.
 * @param {number} p - Percentile (0-1).
 * @returns {number} Interpolated percentile value, rounded to nearest integer.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(sorted[lower]);
  const weight = index - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

/**
 * Get salary distribution data grouped by a specified dimension.
 *
 * @param {object} filters
 * @param {string} [filters.keyword] - Keyword to match against title and role.
 * @param {string} [filters.location] - Location partial match.
 * @param {string} [filters.source] - Exact source match.
 * @param {string} [filters.aps_level] - APS classification level or 'all'.
 * @param {string} [filters.group_by='location'] - Grouping dimension.
 * @returns {{ groups: Array, meta: { total_matching: number, truncated: boolean } }}
 */
function getDistribution(filters = {}) {
  const db = getDb();
  const groupByKey = filters.group_by || 'location';
  const groupColumn = GROUP_BY_WHITELIST[groupByKey];

  if (!groupColumn) {
    throw new Error(`Invalid group_by value: ${groupByKey}`);
  }

  const whereClauses = [
    'salary_min IS NOT NULL',
    'is_active = 1',
    'salary_min >= @outlier_min',
    'salary_min <= @outlier_max',
  ];
  const params = {
    outlier_min: OUTLIER_MIN,
    outlier_max: OUTLIER_MAX,
  };

  if (filters.keyword) {
    whereClauses.push('(title LIKE @keyword_pattern OR role LIKE @keyword_pattern)');
    params.keyword_pattern = `%${filters.keyword}%`;
  }

  if (filters.location) {
    whereClauses.push('location LIKE @location_pattern');
    params.location_pattern = `%${filters.location}%`;
  }

  if (filters.source) {
    whereClauses.push('source = @source');
    params.source = filters.source;
  }

  if (filters.aps_level && filters.aps_level.toLowerCase() !== 'all') {
    whereClauses.push('aps_classification = @aps_level');
    params.aps_level = filters.aps_level;
  } else if (filters.aps_level && filters.aps_level.toLowerCase() === 'all') {
    whereClauses.push('aps_classification IS NOT NULL');
  }

  // Use a safe column name by mapping through whitelist (no interpolation of user input)
  const sql = `SELECT ${groupColumn}, salary_min, salary_max
    FROM jobs
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY ${groupColumn}, salary_min ASC
    LIMIT @row_cap`;

  params.row_cap = ROW_CAP;

  const rows = db.prepare(sql).all(params);

  const truncated = rows.length === ROW_CAP;

  // Group rows by the group column value
  const groupMap = new Map();
  for (const row of rows) {
    const label = row[groupColumn] || 'Unknown';
    if (!groupMap.has(label)) {
      groupMap.set(label, []);
    }
    groupMap.get(label).push(row);
  }

  // Compute statistics for each group
  const allGroups = [];
  for (const [label, groupRows] of groupMap) {
    const salaryMins = groupRows.map((r) => r.salary_min).sort((a, b) => a - b);
    const effectiveMaxes = groupRows.map((r) =>
      r.salary_max != null ? r.salary_max : r.salary_min
    );

    const count = salaryMins.length;
    const min = salaryMins[0];
    const q1 = percentile(salaryMins, 0.25);
    const median = percentile(salaryMins, 0.5);
    const q3 = percentile(salaryMins, 0.75);
    const max = Math.max(...effectiveMaxes);

    allGroups.push({ label, count, min, q1, median, q3, max });
  }

  // Sort groups
  const isApsBreakdown = groupByKey === 'aps_classification';
  if (isApsBreakdown) {
    allGroups.sort((a, b) => {
      const ai = APS_HIERARCHY.indexOf(a.label);
      const bi = APS_HIERARCHY.indexOf(b.label);
      // Unknown APS levels go to the end
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  } else {
    allGroups.sort((a, b) => b.count - a.count);
  }

  // Total matching before truncation to top 10
  const totalMatching = allGroups.reduce((sum, g) => sum + g.count, 0);

  // Top 10 groups
  const groups = allGroups.slice(0, 10);

  return {
    groups,
    meta: {
      total_matching: totalMatching,
      truncated,
    },
  };
}

/**
 * Get available filter options from salary-bearing active jobs.
 *
 * @returns {{ locations: string[], sources: string[], aps_classifications: string[] }}
 */
function getFilterOptions() {
  const db = getDb();

  const baseWhere = 'salary_min IS NOT NULL AND is_active = 1 AND salary_min >= @outlier_min AND salary_min <= @outlier_max';
  const baseParams = { outlier_min: OUTLIER_MIN, outlier_max: OUTLIER_MAX };

  const locations = db
    .prepare(
      `SELECT DISTINCT location FROM jobs WHERE ${baseWhere} AND location IS NOT NULL ORDER BY location ASC`
    )
    .all(baseParams)
    .map((r) => r.location);

  const sources = db
    .prepare(
      `SELECT DISTINCT source FROM jobs WHERE ${baseWhere} AND source IS NOT NULL ORDER BY source ASC`
    )
    .all(baseParams)
    .map((r) => r.source);

  const apsRows = db
    .prepare(
      `SELECT DISTINCT aps_classification FROM jobs WHERE ${baseWhere} AND aps_classification IS NOT NULL`
    )
    .all(baseParams)
    .map((r) => r.aps_classification);

  // Sort APS classifications by hierarchy
  const aps_classifications = apsRows.sort((a, b) => {
    const ai = APS_HIERARCHY.indexOf(a);
    const bi = APS_HIERARCHY.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return { locations, sources, aps_classifications };
}

/**
 * Get metadata about salary data coverage.
 *
 * @returns {{ total_listings: number, listings_with_salary: number, coverage_pct: number }}
 */
function getMeta() {
  const db = getDb();

  const totalRow = db
    .prepare('SELECT COUNT(*) as cnt FROM jobs WHERE is_active = 1')
    .get();
  const total_listings = totalRow.cnt;

  const salaryRow = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM jobs WHERE is_active = 1 AND salary_min IS NOT NULL'
    )
    .get();
  const listings_with_salary = salaryRow.cnt;

  const coverage_pct =
    total_listings > 0
      ? Math.round((listings_with_salary / total_listings) * 1000) / 10
      : 0;

  return { total_listings, listings_with_salary, coverage_pct };
}

module.exports = {
  getDistribution,
  getFilterOptions,
  getMeta,
  // Exported for testing
  _percentile: percentile,
  _APS_HIERARCHY: APS_HIERARCHY,
  _OUTLIER_MIN: OUTLIER_MIN,
  _OUTLIER_MAX: OUTLIER_MAX,
  _ROW_CAP: ROW_CAP,
};
