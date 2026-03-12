export type UserRole = 'candidate' | 'employer' | 'admin';
export type JobStatus = 'active' | 'closed' | 'draft';
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary';
export type ApplicationStatus = 'submitted' | 'viewed' | 'interview' | 'hired' | 'rejected';
export type ArticleStatus = 'draft' | 'published';

// ─── Database row types ───────────────────────────────────────────────────────

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
}

export interface CandidateProfileRow {
  user_id: number;
  full_name: string;
  phone: string | null;
  location: string | null;
  summary: string | null;
  skills: string | null; // JSON array stored as text
  experience_years: number | null;
  expected_salary: number | null;
  updated_at: string;
}

export interface EmployerProfileRow {
  user_id: number;
  company_name: string;
  company_logo: string | null;
  industry: string | null;
  description: string | null;
  website: string | null;
  updated_at: string;
}

export interface JobRow {
  id: number;
  employer_id: number;
  title: string;
  description: string;
  category: string;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  employment_type: EmploymentType;
  status: JobStatus;
  created_at: string;
  expires_at: string | null;
  featured: number; // SQLite stores booleans as 0/1
}

export interface ApplicationRow {
  id: number;
  job_id: number;
  candidate_id: number;
  status: ApplicationStatus;
  applied_at: string;
}

export interface ArticleRow {
  id: number;
  title: string;
  slug: string;
  body: string;
  author_id: number;
  status: ArticleStatus;
  published_at: string | null;
  created_at: string;
}

// ─── Request body types ───────────────────────────────────────────────────────

export interface RegisterBody {
  email: string;
  password: string;
  role: UserRole;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface CreateJobBody {
  title: string;
  description: string;
  category: string;
  location: string;
  salary_min?: number;
  salary_max?: number;
  employment_type: EmploymentType;
  status?: JobStatus;
  expires_at?: string;
  featured?: boolean;
}

export interface UpdateJobBody extends Partial<CreateJobBody> {}

export interface CreateApplicationBody {
  job_id: number;
}

export interface UpdateApplicationStatusBody {
  status: ApplicationStatus;
}

export interface UpdateCandidateProfileBody {
  full_name?: string;
  phone?: string;
  location?: string;
  summary?: string;
  skills?: string[];
  experience_years?: number;
  expected_salary?: number;
}

export interface UpdateEmployerProfileBody {
  company_name?: string;
  company_logo?: string;
  industry?: string;
  description?: string;
  website?: string;
}

export interface CreateArticleBody {
  title: string;
  slug: string;
  body: string;
  status?: ArticleStatus;
}

// ─── Response / DTO types ─────────────────────────────────────────────────────

export interface AuthTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface JWTPayload {
  sub: string; // user id as string
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// ─── Cloudflare env bindings ──────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  OPENAI_API_KEY: string;
}

// ─── AI / Matching types ──────────────────────────────────────────────────────

export interface JobAlertRow {
  id: number;
  candidate_id: number;
  name: string;
  keywords: string | null;
  category: string | null;
  location: string | null;
  employment_type: string | null;
  salary_min: number | null;
  use_ai_matching: number; // 0 | 1
  is_active: number;       // 0 | 1
  last_triggered_at: string | null;
  created_at: string;
}

export interface CreateJobAlertBody {
  name?: string;
  keywords?: string;
  category?: string;
  location?: string;
  employment_type?: string;
  salary_min?: number;
  use_ai_matching?: boolean;
}

export interface ChatbotSessionRow {
  id: string;
  user_id: number | null;
  user_type: 'candidate' | 'employer' | 'anonymous';
  created_at: string;
  last_active: string;
}

export interface ChatbotMessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  intent: string | null;
  tokens_used: number | null;
  created_at: string;
}

export interface AiEmbeddingRow {
  entity_type: 'job' | 'candidate';
  entity_id: number;
  embedding: string; // JSON-serialised number[]
  model: string;
  created_at: string;
  updated_at: string;
}

export interface CvParsedDataRow {
  candidate_id: number;
  raw_text: string | null;
  parsed_json: string | null; // JSON: ParsedCvData
  parsed_at: string;
}

export interface ParsedCvData {
  full_name?: string;
  phone?: string;
  location?: string;
  summary?: string;
  skills: string[];
  experience_years?: number;
  expected_salary?: number;
  education: Array<{ institution: string; degree: string; year?: number }>;
  experience: Array<{ company: string; title: string; years?: number; description?: string }>;
  languages: string[];
}

// ─── Hono context variables ───────────────────────────────────────────────────

export interface Variables {
  userId: number;
  userEmail: string;
  userRole: UserRole;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}
