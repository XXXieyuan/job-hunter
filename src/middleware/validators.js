const { z } = require('zod');

// ============================================================
// Zod Schemas
// ============================================================

const registerSchema = z.object({
  email: z
    .string()
    .email('Must be a valid email address')
    .max(255, 'Email must be 255 characters or less'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be 128 characters or less'),
  display_name: z
    .string()
    .max(100, 'Display name must be 100 characters or less')
    .optional(),
});

const loginSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

const searchFiltersSchema = z.object({
  q: z.string().max(200, 'Search query too long').optional(),
  location: z.string().max(100).optional(),
  source: z
    .enum(['linkedin', 'seek', 'apsjobs', 'manual', 'upload'])
    .optional(),
  work_type: z
    .enum(['full-time', 'part-time', 'contract', 'casual'])
    .optional(),
  visa: z
    .enum(['citizens_only', 'pr_required', 'visa_holders_welcome', 'unknown'])
    .optional(),
  aps_class: z.string().max(10).optional(),
  sort: z.enum(['posted_at', 'score']).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
});

const scraperConfigSchema = z.object({
  name: z.enum(['linkedin', 'seek', 'apsjobs'], {
    required_error: 'Scraper name is required',
    invalid_type_error: 'Invalid scraper name',
  }),
  options: z
    .object({
      keywords: z.string().max(500).optional(),
      location: z.string().max(100).optional(),
      maxPages: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
});

const resumeUploadMetaSchema = z.object({
  name: z
    .string()
    .min(1, 'Resume name is required')
    .max(200, 'Resume name must be 200 characters or less'),
});

const applicationSchema = z.object({
  job_id: z.number().int().positive('Job ID is required'),
  status: z
    .enum([
      'saved',
      'applied',
      'interviewing',
      'offered',
      'rejected',
      'withdrawn',
    ])
    .optional(),
  notes: z.string().max(5000).optional(),
});

const applicationUpdateSchema = z.object({
  status: z
    .enum([
      'saved',
      'applied',
      'interviewing',
      'offered',
      'rejected',
      'withdrawn',
    ])
    .optional(),
  notes: z.string().max(5000).optional(),
});

const skillSchema = z.object({
  name: z.string(),
  category: z.string().optional(),
  proficiency: z.string().optional(),
});

const experienceSchema = z.object({
  title: z.string(),
  employer: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  description: z.string().optional(),
});

const educationSchema = z.object({
  degree: z.string().optional(),
  field: z.string().optional(),
  institution: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});

const certificationSchema = z.object({
  name: z.string(),
  issuer: z.string().optional(),
  date: z.string().optional(),
});

const resumeUpdateSchema = z.object({
  summary: z.string().max(5000).optional(),
  skills_json: z.array(skillSchema).optional(),
  experience_json: z.array(experienceSchema).optional(),
  education_json: z.array(educationSchema).optional(),
  certifications_json: z.array(certificationSchema).optional(),
  is_confirmed: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
});

const coverLetterRequestSchema = z.object({
  job_id: z.number().int().positive('Job ID is required'),
  resume_id: z.number().int().positive('Resume ID is required'),
  language: z.enum(['en', 'zh']).optional(),
  mode: z.enum(['standard', 'aps_selection_criteria']).optional(),
});

const scoreFeedbackSchema = z.object({
  job_id: z.number().int().positive('Job ID is required'),
  resume_id: z.number().int().positive('Resume ID is required'),
  feedback_type: z.enum(['too_high', 'too_low', 'irrelevant', 'helpful'], {
    required_error: 'Feedback type is required',
  }),
  comment: z.string().max(1000).optional(),
});

// ============================================================
// Middleware factory
// ============================================================

/**
 * Creates an Express middleware that validates req.body against a Zod schema.
 * On validation failure, responds with a structured 400 error.
 *
 * @param {z.ZodSchema} schema
 * @param {'body'|'query'} source - Which part of req to validate
 * @returns {Function} Express middleware
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const data = source === 'query' ? req.query : req.body;
    const result = schema.safeParse(data);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));

      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details,
        },
      });
    }

    // Replace with parsed (and coerced) data
    if (source === 'query') {
      req.validatedQuery = result.data;
    } else {
      req.validatedBody = result.data;
    }

    next();
  };
}

// ============================================================
// Pre-built middleware exports
// ============================================================

const validateRegister = validate(registerSchema);
const validateLogin = validate(loginSchema);
const validateSearchFilters = validate(searchFiltersSchema, 'query');
const validateScraperConfig = validate(scraperConfigSchema);
const validateResumeUploadMeta = validate(resumeUploadMetaSchema);
const validateApplication = validate(applicationSchema);
const validateApplicationUpdate = validate(applicationUpdateSchema);
const validateCoverLetterRequest = validate(coverLetterRequestSchema);
const validateScoreFeedback = validate(scoreFeedbackSchema);
const validateResumeUpdate = validate(resumeUpdateSchema);

module.exports = {
  // Schemas (for direct use / testing)
  registerSchema,
  loginSchema,
  searchFiltersSchema,
  scraperConfigSchema,
  resumeUploadMetaSchema,
  resumeUpdateSchema,
  applicationSchema,
  applicationUpdateSchema,
  coverLetterRequestSchema,
  scoreFeedbackSchema,

  // Factory
  validate,

  // Pre-built middleware
  validateRegister,
  validateLogin,
  validateSearchFilters,
  validateScraperConfig,
  validateResumeUploadMeta,
  validateResumeUpdate,
  validateApplication,
  validateApplicationUpdate,
  validateCoverLetterRequest,
  validateScoreFeedback,
};
