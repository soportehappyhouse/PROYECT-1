import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface PanelProps {
  title: string;
  /** Module that owns the implementation, shown while the panel is a stub. */
  todo?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

/** Common chrome for every dashboard panel. */
export function Panel({ title, todo, actions, children }: PanelProps) {
  return (
    <Card className="h-full min-h-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {actions}
      </CardHeader>
      <CardContent>
        {children ?? <p className="text-muted-foreground">Pendiente de implementación ({todo}).</p>}
      </CardContent>
    </Card>
  );
}
