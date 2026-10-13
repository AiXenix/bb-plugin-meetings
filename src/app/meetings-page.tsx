// The "Встречи" nav panel: routes the panel's subPath to a page.
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { DetailPage } from "./detail-page";
import { ListPage } from "./list-page";
import { parseRoute, useMeetingsNav } from "./route";
import { EmptyState, PageFrame } from "./ui";
import { ZoomLoginPage } from "./zoom-login-page";

export function MeetingsPage({ subPath }: PluginNavPanelProps) {
  const nav = useMeetingsNav();
  const route = parseRoute(subPath);
  switch (route.kind) {
    case "list":
      return <ListPage nav={nav} />;
    case "zoom-login":
      return <ZoomLoginPage nav={nav} />;
    case "detail":
      return <DetailPage key={route.id} id={route.id} segmentId={route.segmentId} nav={nav} />;
    case "unknown":
      return (
        <PageFrame>
          <EmptyState className="mt-4">
            <p>Страница «{route.subPath}» не найдена.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => nav.toList({ replace: true })}
            >
              К списку встреч
            </Button>
          </EmptyState>
        </PageFrame>
      );
  }
}
