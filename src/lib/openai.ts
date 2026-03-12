/**
 * OpenAI helper utilities for Recruit.com.hk
 *
 * Uses openai npm package v6+ which is compatible with Cloudflare Workers
 * (relies on the Fetch API, not Node.js http module).
 *
 * Models used:
 *   - text-embedding-3-small  — 1536-dim embeddings for job/candidate matching
 *   - gpt-4o-mini             — chatbot, CV parsing, intent classification
 */

import OpenAI from 'openai';

// ─── Client factory ───────────────────────────────────────────────────────────
// Call this inside each request handler — Cloudflare Workers are stateless so
// we can't create a module-level singleton.

export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

/**
 * Generate an embedding vector for a text string.
 * Returns a float array of length EMBEDDING_DIMS.
 */
export async function generateEmbedding(
  client: OpenAI,
  text: string
): Promise<number[]> {
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000), // stay within token limit
    encoding_format: 'float',
  });
  return response.data[0].embedding;
}

/**
 * Build a searchable text representation for a job listing.
 */
export function jobToText(job: {
  title: string;
  description: string;
  category: string;
  location: string;
  employment_type: string;
  salary_min?: number | null;
  salary_max?: number | null;
  company_name?: string;
}): string {
  const salary =
    job.salary_min || job.salary_max
      ? `Salary: HKD ${job.salary_min ?? ''}-${job.salary_max ?? ''}/month.`
      : '';
  return [
    `Job title: ${job.title}.`,
    `Company: ${job.company_name ?? 'Unknown'}.`,
    `Category: ${job.category}.`,
    `Location: ${job.location}.`,
    `Type: ${job.employment_type}.`,
    salary,
    job.description.slice(0, 500),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Build a searchable text representation for a candidate profile.
 */
export function candidateToText(profile: {
  full_name: string;
  summary?: string | null;
  skills?: string | null; // JSON array string
  experience_years?: number | null;
  expected_salary?: number | null;
  location?: string | null;
}): string {
  const skills = profile.skills ? JSON.parse(profile.skills).join(', ') : '';
  const salary = profile.expected_salary
    ? `Expected salary: HKD ${profile.expected_salary}/month.`
    : '';
  return [
    `Candidate: ${profile.full_name}.`,
    profile.location ? `Location: ${profile.location}.` : '',
    profile.experience_years ? `Experience: ${profile.experience_years} years.` : '',
    skills ? `Skills: ${skills}.` : '',
    salary,
    profile.summary ? profile.summary.slice(0, 400) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two equal-length vectors.
 * Returns a value between 0 (dissimilar) and 1 (identical).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Hybrid match score ───────────────────────────────────────────────────────

/**
 * Compute a hybrid match score (0–1) combining:
 *   60% — semantic similarity (cosine of embeddings)
 *   40% — structured criteria (location, salary, employment type)
 */
export function hybridMatchScore(
  vectorScore: number,
  criteria: {
    locationMatch: boolean;
    salaryInRange: boolean;
    employmentTypeMatch: boolean;
  }
): number {
  const structuredScore =
    (criteria.locationMatch ? 0.4 : 0) +
    (criteria.salaryInRange ? 0.35 : 0) +
    (criteria.employmentTypeMatch ? 0.25 : 0);

  return vectorScore * 0.6 + structuredScore * 0.4;
}

// ─── CV parsing ───────────────────────────────────────────────────────────────

import type { ParsedCvData } from '../types';

/**
 * Use GPT-4o-mini with function calling to extract structured data from raw CV text.
 */
export async function parseCvText(
  client: OpenAI,
  rawText: string
): Promise<ParsedCvData> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are an expert CV parser for a Hong Kong recruitment platform. ' +
          'Extract structured data from the provided CV text. ' +
          'Respond only with the structured JSON — no extra text.',
      },
      {
        role: 'user',
        content: `Parse this CV and extract structured information:\n\n${rawText.slice(0, 6000)}`,
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'extract_cv_data',
          description: 'Extract structured data from a CV/resume',
          parameters: {
            type: 'object',
            properties: {
              full_name: { type: 'string', description: "Candidate's full name" },
              phone: { type: 'string', description: 'Phone number' },
              location: { type: 'string', description: 'City or district (HK context)' },
              summary: { type: 'string', description: 'Professional summary or objective' },
              skills: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of technical and soft skills',
              },
              experience_years: {
                type: 'number',
                description: 'Total years of work experience',
              },
              expected_salary: {
                type: 'number',
                description: 'Expected monthly salary in HKD (if mentioned)',
              },
              education: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    institution: { type: 'string' },
                    degree: { type: 'string' },
                    year: { type: 'number' },
                  },
                  required: ['institution', 'degree'],
                },
              },
              experience: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    company: { type: 'string' },
                    title: { type: 'string' },
                    years: { type: 'number' },
                    description: { type: 'string' },
                  },
                  required: ['company', 'title'],
                },
              },
              languages: {
                type: 'array',
                items: { type: 'string' },
                description: 'Languages spoken (e.g. Cantonese, English, Mandarin)',
              },
            },
            required: ['skills', 'education', 'experience', 'languages'],
          },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'extract_cv_data' } },
    max_tokens: 1500,
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return { skills: [], education: [], experience: [], languages: [] };
  }

  try {
    return JSON.parse(toolCall.function.arguments) as ParsedCvData;
  } catch {
    return { skills: [], education: [], experience: [], languages: [] };
  }
}

// ─── Chatbot ──────────────────────────────────────────────────────────────────

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };
export type ChatIntent =
  | 'job_search'
  | 'app_status'
  | 'career_advice'
  | 'employer_faq'
  | 'general';

const SYSTEM_PROMPT = `You are a helpful assistant for Recruit.com.hk, Hong Kong's job recruitment platform.
You help job seekers find jobs, check application statuses, and get career advice.
You also help employers with FAQ about posting jobs and managing applications.
Always respond in the same language the user writes in (English or Traditional Chinese).
Keep answers concise and relevant to Hong Kong's job market.
Do NOT reveal personal data of other users. Do NOT discuss topics unrelated to recruitment or careers.`;

/**
 * Classify the intent of a user message.
 */
export async function classifyIntent(
  client: OpenAI,
  message: string
): Promise<ChatIntent> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Classify the user message into exactly one of these intents: ' +
          'job_search, app_status, career_advice, employer_faq, general. ' +
          'Respond with only the intent label.',
      },
      { role: 'user', content: message },
    ],
    max_tokens: 10,
    temperature: 0,
  });

  const label = response.choices[0]?.message?.content?.trim().toLowerCase() ?? 'general';
  const valid: ChatIntent[] = ['job_search', 'app_status', 'career_advice', 'employer_faq', 'general'];
  return valid.includes(label as ChatIntent) ? (label as ChatIntent) : 'general';
}

/**
 * Generate a chatbot reply given a conversation history.
 * Returns { reply, tokensUsed }.
 */
export async function chatReply(
  client: OpenAI,
  history: ChatMessage[],
  context?: string // optional injected context (e.g. job search results)
): Promise<{ reply: string; tokensUsed: number }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + (context ? `\n\nContext:\n${context}` : '') },
    ...history.slice(-20), // keep last 20 messages to stay within token budget
  ];

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 600,
    temperature: 0.7,
  });

  return {
    reply: response.choices[0]?.message?.content ?? 'Sorry, I could not generate a response.',
    tokensUsed: response.usage?.total_tokens ?? 0,
  };
}
