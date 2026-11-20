import { Construction } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "../design/index.js";
import { useBreadcrumbs } from "../shell/AppShell.js";
import { PageHeader } from "./common.js";

/** Honest placeholder for pages that land in a later phase of the redesign. */
export function UpcomingPage({ title, description, interim }: { title: string; description: string; interim?: string }) {
  useBreadcrumbs([{ label: title }]);
  return (
    <div className="page">
      <PageHeader title={title} description={description} />
      <div className="card">
        <EmptyState icon={<Construction size={20} />} title="Not built yet"
          action={<Link to="/runs" className="btn btn--secondary btn--sm"><span>Go to runs</span></Link>}>
          This page is part of the next phase of the console redesign.{interim ? ` ${interim}` : ""}
        </EmptyState>
      </div>
    </div>
  );
}
