import {
  Button,
  Card,
  Heading,
  Input,
  Text,
  Textarea,
} from "@instafy/frontend/feature-api/ui";

type UserPreferences = {
  preferredMaxLinearVelocityMps: number;
  preferredMaxAngularVelocityDps: number;
  preferredHeadMotionScale: number;
};

type RobotCommandDebuggerSectionProps = {
  busy: boolean;
  agentBusy: boolean;
  customCommand: string;
  onCustomCommandChange: (value: string) => void;
  onLookLeft: () => void;
  onCenter: () => void;
  onLookRight: () => void;
  onDriveArc: () => void;
  onStop: () => void;
  onSendCustomCommand: () => void;
  preferences: UserPreferences;
  onPreferredMaxLinearVelocityChange: (value: string) => void;
  onPreferredMaxAngularVelocityChange: (value: string) => void;
  onPreferredHeadMotionScaleChange: (value: string) => void;
  onRecordPreferenceUpdate: () => void;
  onResetPreferences: () => void;
  onRobotTooFast: () => void;
  onRobotVeeredLeft: () => void;
};

export function RobotCommandDebuggerSection({
  busy,
  agentBusy,
  customCommand,
  onCustomCommandChange,
  onLookLeft,
  onCenter,
  onLookRight,
  onDriveArc,
  onStop,
  onSendCustomCommand,
  preferences,
  onPreferredMaxLinearVelocityChange,
  onPreferredMaxAngularVelocityChange,
  onPreferredHeadMotionScaleChange,
  onRecordPreferenceUpdate,
  onResetPreferences,
  onRobotTooFast,
  onRobotVeeredLeft,
}: RobotCommandDebuggerSectionProps) {
  return (
    <>
      <Card tone="muted" padding="md" className="mt-4 border-slate-200/70 bg-white/75">
        <Text variant="caption" tone="muted">
          Low-level transport debugging
        </Text>
        <Heading level={3} variant="subtitle" className="mt-2">
          Raw command surface
        </Heading>
        <Text variant="body" tone="secondary" className="mt-2">
          Keep this for contract debugging and transport inspection. The high-level agent
          capability should compile down to this surface, not replace it.
        </Text>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onPress={onLookLeft} isDisabled={busy || agentBusy}>
            Look left
          </Button>
          <Button variant="secondary" onPress={onCenter} isDisabled={busy || agentBusy}>
            Center
          </Button>
          <Button variant="secondary" onPress={onLookRight} isDisabled={busy || agentBusy}>
            Look right
          </Button>
          <Button variant="outline" onPress={onDriveArc} isDisabled={busy || agentBusy}>
            Drive arc
          </Button>
          <Button variant="danger" onPress={onStop} isDisabled={busy || agentBusy}>
            Stop
          </Button>
        </div>
        <Text variant="caption" tone="muted" className="mt-4">
          Custom command JSON
        </Text>
        <Textarea
          rows={8}
          className="mt-2 font-mono text-xs"
          value={customCommand}
          onChange={(event) => onCustomCommandChange(event.target.value)}
        />
        <Button
          className="mt-3"
          variant="primary"
          onPress={onSendCustomCommand}
          isDisabled={busy || agentBusy}
        >
          Send custom command
        </Button>
      </Card>

      <div className="mt-4 grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
        <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
          <Text variant="caption" tone="muted">
            Preference memory
          </Text>
          <Heading level={3} variant="subtitle" className="mt-2">
            Clamp behavior before it reaches the robot
          </Heading>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Text variant="caption" tone="muted">
                Max linear m/s
              </Text>
              <Input
                type="number"
                step="0.01"
                value={preferences.preferredMaxLinearVelocityMps}
                onChange={(event) => onPreferredMaxLinearVelocityChange(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Text variant="caption" tone="muted">
                Max angular deg/s
              </Text>
              <Input
                type="number"
                step="1"
                value={preferences.preferredMaxAngularVelocityDps}
                onChange={(event) => onPreferredMaxAngularVelocityChange(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Text variant="caption" tone="muted">
                Head motion scale
              </Text>
              <Input
                type="number"
                step="0.1"
                value={preferences.preferredHeadMotionScale}
                onChange={(event) => onPreferredHeadMotionScaleChange(event.target.value)}
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onPress={onRecordPreferenceUpdate}>
              Record preference update
            </Button>
            <Button variant="outline" onPress={onResetPreferences}>
              Reset defaults
            </Button>
          </div>
        </Card>

        <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
          <Text variant="caption" tone="muted">
            Correction capture
          </Text>
          <Heading level={3} variant="subtitle" className="mt-2">
            Record live feedback signals
          </Heading>
          <Text variant="body" tone="secondary" className="mt-2">
            These events are the beginning of the future replay and adaptation loop.
          </Text>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onPress={onRobotTooFast}>
              Robot was too fast
            </Button>
            <Button variant="secondary" onPress={onRobotVeeredLeft}>
              Robot veered left
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
