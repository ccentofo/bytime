/** Display names of indirect-code categories (timesheet grid, review, PDF, audit trail). */
export const INDIRECT_CATEGORY_LABELS: Record<string, string> = {
  overhead: 'Overhead',
  ga: 'G&A',
  irad: 'IR&D',
  bp: 'Bid & Proposal',
  leave: 'Leave',
  unallowable: 'Unallowable',
};

export const indirectCategoryLabel = (category: string): string => INDIRECT_CATEGORY_LABELS[category] ?? category;
