import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";

type CommandCenterPlaceholderPageProps = {
  title: string;
  description: string;
  sections: string[];
};

export default function CommandCenterPlaceholderPage({
  title,
  description,
  sections,
}: CommandCenterPlaceholderPageProps) {
  return (
    <div>
      <CommandCenterPageHeader title={title} description={description} />
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((section) => (
          <CommandCenterCard key={section} title={section}>
            <div className="rounded-2xl border border-dashed border-border/60 bg-background/20 p-4 text-sm text-mw-muted">
              Phase 1 placeholder. This route now opens inside the private Command Center shell; detailed data and actions come in the feature batch.
            </div>
          </CommandCenterCard>
        ))}
      </div>
    </div>
  );
}
