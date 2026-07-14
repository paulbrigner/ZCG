import AdminPage from "../admin/page";

type DashboardSearchParams = {
  applicationFilter?: string | string[];
  applicationSearch?: string | string[];
  applicationStatus?: string | string[];
  githubIssueState?: string | string[];
  applicationLabels?: string | string[];
  excludedApplicationLabels?: string | string[];
  applicationPage?: string | string[];
  applicationSort?: string | string[];
  worklistOrder?: string | string[];
};

export default async function DashboardPage({
  searchParams
}: {
  searchParams?: Promise<DashboardSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};

  return AdminPage({
    searchParams: Promise.resolve({
      ...resolvedSearchParams,
      dashboardView: "1"
    })
  });
}
