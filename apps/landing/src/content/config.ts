import { defineCollection, z, } from "astro:content";

const contentSchema = z.object({
  title: z.string(),
  summary: z.string(),
  publishedAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  pageType: z.enum(["blog", "guide", "use-case", "comparison", "glossary",],),
  canonicalPath: z.string().startsWith("/",),
  primaryQuery: z.string(),
  evidenceIds: z.array(z.string(),).default([],),
  status: z.enum(["draft", "published",],).default("published",),
  ownership: z.enum(["generated", "manual",],).default("manual",),
  bestFor: z.array(z.string(),).default([],),
  notFor: z.array(z.string(),).default([],),
  faqs: z.array(z.object({
    question: z.string(),
    answer: z.string(),
  },),).default([],),
  relatedLinks: z.array(z.object({
    label: z.string(),
    href: z.string().startsWith("/",),
  },),).default([],),
  image: z.string().startsWith("/",).optional(),
},);

const blog = defineCollection({ schema: contentSchema, },);
const guides = defineCollection({ schema: contentSchema, },);
const useCases = defineCollection({ schema: contentSchema, },);
const comparisons = defineCollection({ schema: contentSchema, },);
const glossary = defineCollection({ schema: contentSchema, },);

export const collections = {
  blog,
  guides,
  "use-cases": useCases,
  comparisons,
  glossary,
};
