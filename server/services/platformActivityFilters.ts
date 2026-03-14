export const buildPlatformActivitySearchClauses = (activitySearch: string) => {
  const trimmedSearch = activitySearch.replace(/[,]/g, ' ').trim();
  if (!trimmedSearch) return [];

  return [
    `event_name.ilike.%${trimmedSearch}%`,
    `page_path.ilike.%${trimmedSearch}%`,
    `actor_email.ilike.%${trimmedSearch}%`,
    `error_message.ilike.%${trimmedSearch}%`,
  ];
};

export const buildPlatformFailureFilter = (activitySearch: string) => {
  const searchClauses = buildPlatformActivitySearchClauses(activitySearch);
  if (searchClauses.length === 0) {
    return 'category.eq.error,event_name.eq.api.request.failed';
  }

  const nestedSearch = `or(${searchClauses.join(',')})`;
  return [
    `and(category.eq.error,${nestedSearch})`,
    `and(event_name.eq.api.request.failed,${nestedSearch})`,
  ].join(',');
};
