import { absoluteUrl, siteConfig, } from "./site";

export type ContentPageType = "blog" | "guide" | "use-case" | "comparison" | "glossary";
export type ContentStatus = "draft" | "published";
export type ContentOwnership = "generated" | "manual";

export interface ContentFrontmatter {
  title: string;
  summary: string;
  publishedAt: Date;
  updatedAt: Date;
  pageType: ContentPageType;
  canonicalPath: string;
  primaryQuery: string;
  evidenceIds: string[];
  status: ContentStatus;
  ownership: ContentOwnership;
  bestFor: string[];
  notFor: string[];
  faqs: Array<{ question: string; answer: string; }>;
  relatedLinks: Array<{ label: string; href: string; }>;
  image?: string;
}

export interface ContentEntryLike {
  slug: string;
  body?: string;
  data: ContentFrontmatter;
}

export const contentSections = {
  blog: {
    collection: "blog",
    label: "Blog",
    title: "Notes from the team",
    description: "Product notes from the Philo team on daily planning, recurring systems, and disposable widgets.",
    pageType: "blog",
  },
  guides: {
    collection: "guides",
    label: "Guides",
    title: "Philo guides",
    description: "How to use Philo's daily planning model, markdown storage, recurring tasks, and widget workflow.",
    pageType: "guide",
  },
  "use-cases": {
    collection: "use-cases",
    label: "Use cases",
    title: "Use Philo for real planning loops",
    description:
      "Practical ways to use Philo for daily planning, recurring work, markdown-native notes, and lightweight systems.",
    pageType: "use-case",
  },
  comparisons: {
    collection: "comparisons",
    label: "Comparisons",
    title: "Compare Philo to adjacent workflows",
    description: "Tradeoff-driven comparisons for people deciding whether Philo fits their planning workflow.",
    pageType: "comparison",
  },
  glossary: {
    collection: "glossary",
    label: "Glossary",
    title: "Philo glossary",
    description: "Clear definitions for the planning primitives that power Philo.",
    pageType: "glossary",
  },
} as const;

export type ContentSection = keyof typeof contentSections;

export function isContentSection(value: string,): value is ContentSection {
  return value in contentSections;
}

export function sortContentEntries<T extends ContentEntryLike,>(entries: T[],): T[] {
  return [...entries,].sort((left, right,) => (
    right.data.updatedAt.getTime() - left.data.updatedAt.getTime()
    || right.data.publishedAt.getTime() - left.data.publishedAt.getTime()
  ));
}

export function isPublishedEntry(entry: ContentEntryLike,): boolean {
  return entry.data.status === "published";
}

export function formatContentDate(date: Date,): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  },);
}

export function buildCollectionSchema(section: ContentSection,) {
  const config = contentSections[section];
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: config.title,
    description: config.description,
    url: absoluteUrl(`/${section}`,),
    isPartOf: {
      "@type": "WebSite",
      name: siteConfig.name,
      url: siteConfig.siteUrl,
    },
  };
}

export function buildContentSchemas(entry: ContentEntryLike,) {
  const imageUrl = absoluteUrl(entry.data.image ?? siteConfig.defaultImagePath,);
  const baseArticle = {
    "@context": "https://schema.org",
    "@type": (
      entry.data.pageType === "blog"
        ? "BlogPosting"
        : entry.data.pageType === "glossary"
        ? "DefinedTerm"
        : "TechArticle"
    ),
    headline: entry.data.title,
    description: entry.data.summary,
    image: imageUrl,
    url: absoluteUrl(entry.data.canonicalPath,),
    datePublished: entry.data.publishedAt.toISOString(),
    dateModified: entry.data.updatedAt.toISOString(),
    author: {
      "@type": "Organization",
      name: siteConfig.name,
    },
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.siteUrl,
    },
    mainEntityOfPage: absoluteUrl(entry.data.canonicalPath,),
  };

  if (entry.data.pageType === "glossary") {
    return [
      {
        ...baseArticle,
        name: entry.data.title,
        termCode: entry.slug,
        inDefinedTermSet: absoluteUrl("/glossary",),
      },
      ...buildFaqSchemas(entry,),
    ];
  }

  return [baseArticle, ...buildFaqSchemas(entry,),];
}

function buildFaqSchemas(entry: ContentEntryLike,) {
  if (entry.data.faqs.length === 0) {
    return [];
  }

  return [{
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entry.data.faqs.map((item,) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
    url: absoluteUrl(entry.data.canonicalPath,),
  },];
}
