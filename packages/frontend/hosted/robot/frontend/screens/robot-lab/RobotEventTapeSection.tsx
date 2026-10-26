import { Badge, Card, Heading, Text } from "@instafy/frontend/feature-api/ui";
import type { RobotBridgeEvent } from "../../robot";

type RobotEventTapeSectionProps = {
  events: RobotBridgeEvent[];
};

export function RobotEventTapeSection({ events }: RobotEventTapeSectionProps) {
  return (
    <Card
      padding="lg"
      className="border-white/70 bg-white/72 shadow-modal backdrop-blur"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <Text variant="overline" tone="muted">
            Event Tape
          </Text>
          <Heading level={2} variant="title" className="mt-1">
            Recent transport events
          </Heading>
        </div>
        <Badge tone="neutral">{events.length} cached</Badge>
      </div>
      <div className="mt-4 space-y-3">
        {events.length === 0 ? (
          <Text variant="body" tone="muted">
            Connect to the local provider host and send a command to start collecting transport
            events.
          </Text>
        ) : (
          <div className="max-h-[26rem] space-y-3 overflow-y-auto pr-1">
            {events.map((event, index) => (
              <pre
                key={`${index}-${JSON.stringify(event).slice(0, 24)}`}
                className="max-h-56 overflow-auto rounded-2xl bg-[#101826] p-3 text-xs text-slate-100"
              >
                {JSON.stringify(event, null, 2)}
              </pre>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
