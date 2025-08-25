import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/DashboardLayout";
import { MetricsForm } from "@/components/MetricsForm";
import { parsePrometheusMetrics } from "@/lib/metrics";
import { useToast } from "@/hooks/use-toast";
import { MetricsOverview } from "@/components/metrics/MetricsOverview";
import { ProviderMetrics } from "@/components/metrics/ProviderMetrics";
import { SystemMetrics } from "@/components/metrics/SystemMetrics";
import { RawMetricsViewer } from "@/components/metrics/RawMetricsViewer";
import { ProviderStatusTable } from "@/components/metrics/ProviderStatusTable";
import { HostnameStatsTable } from "@/components/metrics/HostnameStatsTable";
import { MediaWatchTable } from "@/components/metrics/MediaWatchTable";
import { NavigationIndex } from "@/components/metrics/NavigationIndex";
import { useIsMobile } from "@/hooks/use-mobile";
import Spinner from "@/components/ui/spinner";
import { GitHubButton } from "@/components/ui/GitHubButton";

interface MetricValue {
  name: string;
  value: number;
  labels?: Record<string, string>;
  help?: string;
  type?: string;
}

interface ParsedMetrics {
  processMetrics: MetricValue[];
  nodeMetrics: MetricValue[];
  httpMetrics: MetricValue[];
  customMetrics: MetricValue[];
}

interface ProviderStats {
  [key: string]: {
    success: number;
    failed: number;
    notfound: number;
  };
}

interface RouteTimings {
  [key: string]: {
    sum: number;
    count: number;
  };
}

export default function Dashboard() {
  const [url, setUrl] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<ParsedMetrics, Error>({
    queryKey: ["metrics", url],
    enabled: !!url,
    queryFn: async () => {
      if (!url) throw new Error("No URL provided");
      if (url === "imported") {
        // Return the already parsed data for imported files
        return queryClient.getQueryData<ParsedMetrics>(["metrics", "imported"]) ?? {
          processMetrics: [],
          nodeMetrics: [],
          httpMetrics: [],
          customMetrics: [],
        };
      }
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch metrics: ${response.statusText}`);
        }
        const text = await response.text();
        setRawResponse(text);
        const parsed = parsePrometheusMetrics(text);
        return parsed;
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : "Failed to fetch metrics",
        );
      }
    },
  });

  useEffect(() => {
    if (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    }
  }, [error, toast]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (autoRefresh && url) {
      interval = setInterval(() => {
        refetch();
      }, 30000);
    }
    return () => clearInterval(interval);
  }, [autoRefresh, url, refetch]);

  const handleSubmit = (newUrl: string) => {
    setUrl(newUrl);
  };

  const handleFileImport = (content: string) => {
    setRawResponse(content);
    try {
      const parsed = parsePrometheusMetrics(content);
      // Update the query client cache manually
      queryClient.setQueryData(["metrics", "imported"], parsed);
      setUrl("imported"); // Set a dummy URL to trigger the UI update
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Error parsing file",
        description: err instanceof Error ? err.message : "Failed to parse metrics file",
      });
    }
  };

  const chartData = useMemo(() => {
    if (!data) return null;

    // Group provider status data by provider
    const providerStats = data.customMetrics
      .filter(
        (m: MetricValue) =>
          m.name === "mw_provider_status_count" ||
          m.name === "mw_provider_status_count_daily" ||
          m.name === "mw_provider_status_count_weekly" ||
          m.name === "mw_provider_status_count_monthly",
      )
      .reduce(
        (acc: ProviderStats, curr: MetricValue) => {
          const providerId = curr.labels?.provider_id || "unknown";
          const status = curr.labels?.status || "unknown";
          if (!acc[providerId]) {
            acc[providerId] = { success: 0, failed: 0, notfound: 0 };
          }
          if (
            status === "success" ||
            status === "failed" ||
            status === "notfound"
          ) {
            acc[providerId][status] = curr.value;
          }
          return acc;
        },
        {} as ProviderStats,
      );

    // Calculate failure rates and sort providers
    const providerFailureRates10 = Object.entries(providerStats)
      .map(([provider, stats]: [string, { success: number; failed: number; notfound: number }]) => {
        const total = stats.success + stats.failed + stats.notfound;
        const failureRate = (stats.failed / total) * 100;
        return { provider, failureRate, ...stats };
      })
      .sort((a, b) => b.failureRate - a.failureRate)
      .slice(0, 10);

    const providerFailureRates20 = Object.entries(providerStats)
      .map(([provider, stats]: [string, { success: number; failed: number; notfound: number }]) => {
        const total = stats.success + stats.failed + stats.notfound;
        const failureRate = (stats.failed / total) * 100;
        return { provider, failureRate, ...stats };
      })
      .sort((a, b) => b.failureRate - a.failureRate)
      .slice(0, 20);

    const providerToolData = {
      labels: data.customMetrics
        .filter((m: MetricValue) => m.name === "mw_provider_tool_count")
        .slice(0, 10)
        .map((m: MetricValue) => m.labels?.tool || "unknown"),
      datasets: [
        {
          label: "Provider Tool Usage",
          data: data.customMetrics
            .filter((m: MetricValue) => m.name === "mw_provider_tool_count")
            .slice(0, 10)
            .map((m: MetricValue) => m.value),
          backgroundColor: [
            "rgba(54, 162, 235, 0.8)",
            "rgba(75, 192, 192, 0.8)",
            "rgba(153, 102, 255, 0.8)",
          ],
        },
      ],
    };

    const httpDurationData = {
      labels: data.httpMetrics
        .filter((m: MetricValue) => m.name === "http_request_duration_seconds_count")
        .slice(0, 10)
        .map((m: MetricValue) => `${m.labels?.method || ""} ${m.labels?.route || ""}`),
      datasets: [
        {
          label: "Request Count",
          data: data.httpMetrics
            .filter((m: MetricValue) => m.name === "http_request_duration_seconds_count")
            .slice(0, 10)
            .map((m: MetricValue) => m.value),
          backgroundColor: ["rgba(54, 162, 235, 0.8)"],
        },
      ],
    };

    const providerStatusData = {
      labels: ["Success", "Failed", "Not Found"],
      datasets: [
        {
          label: "Status Count",
          data: [
            data.customMetrics
              .filter(
                (m: MetricValue) =>
                  (m.name === "mw_provider_status_count" ||
                    m.name === "mw_provider_status_count_daily" ||
                    m.name === "mw_provider_status_count_weekly" ||
                    m.name === "mw_provider_status_count_monthly") &&
                  m.labels?.status === "success",
              )
              .reduce((acc: number, curr: MetricValue) => acc + (typeof curr.value === "number" ? curr.value : 0), 0),
            data.customMetrics
              .filter(
                (m: MetricValue) =>
                  (m.name === "mw_provider_status_count" ||
                    m.name === "mw_provider_status_count_daily" ||
                    m.name === "mw_provider_status_count_weekly" ||
                    m.name === "mw_provider_status_count_monthly") &&
                  m.labels?.status === "failed",
              )
              .reduce((acc: number, curr: MetricValue) => acc + (typeof curr.value === "number" ? curr.value : 0), 0),
            data.customMetrics
              .filter(
                (m: MetricValue) =>
                  (m.name === "mw_provider_status_count" ||
                    m.name === "mw_provider_status_count_daily" ||
                    m.name === "mw_provider_status_count_weekly" ||
                    m.name === "mw_provider_status_count_monthly") &&
                  m.labels?.status === "notfound",
              )
              .reduce((acc: number, curr: MetricValue) => acc + (typeof curr.value === "number" ? curr.value : 0), 0),
          ],
          borderColor: "rgba(53, 162, 235, 1)",
          backgroundColor: [
            "rgba(53, 162, 235, 0.5)",
            "rgba(53, 162, 235, 0.5)",
            "rgba(53, 162, 235, 0.5)",
          ],
          fill: true,
        },
      ],
    };

    const providerFailuresData10 = {
      labels: providerFailureRates10.map((p) => p.provider),
      datasets: [
        {
          label: "Failure Rate (%)",
          data: providerFailureRates10.map((p) =>
            parseFloat(p.failureRate.toFixed(1)),
          ),
          backgroundColor: providerFailureRates10.map(
            () => "rgba(239, 68, 68, 0.8)",
          ),
        },
      ],
    };

    const providerFailuresData20 = {
      labels: providerFailureRates20.map((p) => p.provider),
      datasets: [
        {
          label: "Failure Rate (%)",
          data: providerFailureRates20.map((p) =>
            parseFloat(p.failureRate.toFixed(1)),
          ),
          backgroundColor: providerFailureRates20.map(
            () => "rgba(239, 68, 68, 0.8)",
          ),
        },
      ],
    };

    // Calculate average response times by route
    const routeTimings = data.httpMetrics
      .filter((m: MetricValue) => m.name.startsWith("http_request_duration_seconds"))
      .reduce(
        (acc: RouteTimings, curr: MetricValue) => {
          const route = curr.labels?.route;
          const method = curr.labels?.method;
          if (!route || !method) return acc;

          const key = `${method} ${route}`;
          if (!acc[key]) {
            acc[key] = {
              sum: 0,
              count: 0,
            };
          }

          if (curr.name === "http_request_duration_seconds_sum") {
            acc[key].sum = curr.value;
          } else if (curr.name === "http_request_duration_seconds_count") {
            acc[key].count = curr.value;
          }

          return acc;
        },
        {} as RouteTimings,
      );

    // Convert to averages and sort by response time
    const responseTimeData = {
      labels: Object.entries(routeTimings)
        .map(([route, timing]: [string, { sum: number; count: number }]) => ({
          route,
          avgTime: (timing.sum / timing.count) * 1000,
        }))
        .sort((a, b) => b.avgTime - a.avgTime)
        .slice(0, 10)
        .map((entry) => entry.route),
      datasets: [
        {
          label: "Average Response Time (ms)",
          data: Object.entries(routeTimings)
            .map(([_, timing]: [string, { sum: number; count: number }]) =>
              (timing.sum / timing.count) * 1000
            )
            .sort((a, b) => b - a)
            .slice(0, 10),
          backgroundColor: ["rgba(234, 179, 8, 0.8)"],
        },
      ],
    };

    return {
      providerToolData,
      httpDurationData,
      providerStatusData,
      providerFailuresData10,
      providerFailuresData20,
      responseTimeData,
    };
  }, [data]);

  const stats = useMemo(() => {
    if (!data) return null;

    const totalWatchRequests = data.customMetrics
      .filter(
        (m: MetricValue) =>
          m.name === "mw_media_watch_count" ||
          m.name === "mw_media_watch_count_daily" ||
          m.name === "mw_media_watch_count_weekly" ||
          m.name === "mw_media_watch_count_monthly",
      )
      .reduce(
        (acc: number, curr: MetricValue) => acc + (typeof curr.value === "number" ? curr.value : 0),
        0,
      );

    const uniqueHosts = new Set(
      data.customMetrics
        .filter(
          (m: MetricValue) =>
            m.name === "mw_provider_hostname_count" ||
            m.name === "mw_provider_hostname_count_daily" ||
            m.name === "mw_provider_hostname_count_weekly" ||
            m.name === "mw_provider_hostname_count_monthly",
        )
        .map((m: MetricValue) => m.labels?.hostname),
    ).size;

    return {
      totalWatchRequests,
      uniqueHosts,
      activeUsers:
        data.customMetrics.find(
          (m: MetricValue) =>
            m.name === "mw_user_count" ||
            m.name === "mw_user_count_daily" ||
            m.name === "mw_user_count_weekly" ||
            m.name === "mw_user_count_monthly",
        )?.value || 0,
      eventLoopLag: (
        data.nodeMetrics.find((m: MetricValue) => m.name === "nodejs_eventloop_lag_seconds")
          ?.value || 0
      ).toFixed(3),
    };
  }, [data]);

  const isMobile = useIsMobile();

  return (
    <DashboardLayout>
      <div className="mb-8">
        <div className="flex items-center gap-4 mb-6 pl-2">
          <span className="h-12 w-12">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="1em"
                height="1em"
                viewBox="0 0 20.927 20.927"
                preserveAspectRatio="xMidYMid meet"
            >
                <g transform="translate(0,20.927) scale(0.003333,-0.003333)" fill="currentColor" stroke="none">
                    <path d="M3910 5527 c-33 -4 -145 -17 -250 -28 -645 -73 -900 -187 -900 -405 l0 -89 154 -2 c209 -2 225 -17 381 -354 186 -399 337 -491 557 -341 103 70 176 67 252 -9 143 -142 -15 -342 -320 -404 l-123 -25 185 -393 c101 -217 189 -396 194 -398 6 -3 87 6 182 20 499 71 1160 -296 972 -541 -77 -101 -183 -100 -307 2 -186 154 -407 223 -610 188 -123 -21 -119 -9 -80 -274 40 -273 18 -701 -48 -916 -25 -82 252 -99 463 -28 655 220 1146 748 1330 1430 44 165 46 201 53 1206 l8 1035 -67 66 c-185 183 -1376 336 -2026 260z m1078 -1219 c118 -81 204 -84 312 -10 239 163 453 -73 240 -265 -241 -218 -703 -178 -832 71 -93 179 105 323 280 204z"></path>
                    <path d="M2410 4591 c-950 -201 -2404 -1015 -2409 -1348 -1 -69 771 -1707 885 -1878 422 -633 1185 -984 1924 -886 221 29 293 68 482 264 575 594 727 1466 390 2232 -231 525 -749 1600 -785 1630 -57 48 -214 44 -487 -14z m579 -1122 c114 -54 145 -188 64 -281 -48 -56 -60 -58 -265 -47 -102 6 -177 -42 -229 -143 -95 -187 -339 -145 -339 57 0 291 482 550 769 414z m-1319 -630 c215 -106 85 -350 -173 -326 -144 13 -209 -21 -270 -140 -102 -197 -381 -119 -339 94 59 295 506 508 782 372z m1472 -577 c216 -217 -287 -789 -786 -895 -473 -100 -909 127 -654 341 71 60 93 62 226 22 348 -106 739 77 903 423 83 177 201 218 311 109z"></path>
                </g>
            </svg>
          </span>
          <h1 className="text-4xl font-bold">Metrics Dashboard</h1>
        </div>
        <MetricsForm
          onSubmit={handleSubmit}
          onFileImport={handleFileImport}
          isLoading={isLoading}
          autoRefresh={autoRefresh}
          onAutoRefreshToggle={() => setAutoRefresh(!autoRefresh)}
        />
      </div>

      {isMobile && (
        <div className="w-full flex items-center justify-center">
          <p className="text-s text-muted-foreground">
            Please use a larger screen for a better experience.
          </p>
        </div>
      )}

      {isLoading && (
        <div className="flex flex-col items-center justify-center h-64 pt-40">
          <p className="text-lg text-muted-foreground">Loading metrics...</p>
          <Spinner />
        </div>
      )}

      {data && stats && chartData && (
        <div className="space-y-8">
          <NavigationIndex />
          <div id="overview">
            <MetricsOverview stats={stats} />
          </div>
          <div id="provider-performance">
            <ProviderMetrics {...chartData} />
          </div>
          <div id="provider-statistics">
            <ProviderStatusTable metrics={data.customMetrics} />
          </div>
          <div id="watched-content">
            <MediaWatchTable metrics={data.customMetrics} />
          </div>
          <div id="backend-usage">
            <HostnameStatsTable metrics={data.customMetrics} />
          </div>
          <div id="system-performance">
            <SystemMetrics
              httpDurationData={chartData.httpDurationData}
              responseTimeData={chartData.responseTimeData}
            />
          </div>
          {rawResponse && (
            <div id="raw-metrics">
              <RawMetricsViewer
                rawResponse={rawResponse}
                metricsUrl={url || ""}
              />
            </div>
          )}
        </div>
      )}
      <GitHubButton />
    </DashboardLayout>
  );
}
