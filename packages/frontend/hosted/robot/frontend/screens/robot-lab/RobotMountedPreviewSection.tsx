import {
  Badge,
  Card,
  Heading,
  SegmentedControl,
  Text,
} from "@instafy/frontend/feature-api/ui";

type MountMode = "mounted" | "handheld";
type OrientationMode = "landscape" | "portrait";

type StageTransform = {
  shell: string;
  arm: string;
  screen: string;
  pupilX: string;
  pupilY: string;
};

type HeadPose = {
  yaw: number;
  pitch: number;
  elbow: number;
};

type RobotMountedPreviewSectionProps = {
  mountMode: MountMode;
  orientation: OrientationMode;
  onMountModeChange: (value: MountMode) => void;
  onOrientationChange: (value: OrientationMode) => void;
  stageTransform: StageTransform;
  headPose: HeadPose;
};

export function RobotMountedPreviewSection({
  mountMode,
  orientation,
  onMountModeChange,
  onOrientationChange,
  stageTransform,
  headPose,
}: RobotMountedPreviewSectionProps) {
  return (
    <Card
      padding="lg"
      className="overflow-hidden border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.86)_0%,rgba(248,244,238,0.94)_100%)] shadow-modal"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Text variant="overline" tone="muted">
            Mounted UX
          </Text>
          <Heading level={2} variant="title" className="mt-1">
            Phone-as-head preview
          </Heading>
        </div>
        <Badge tone="neutral" size="sm">
          Simulated expression
        </Badge>
      </div>

      <div className="mt-4 flex flex-wrap gap-4">
        <SegmentedControl
          label="Mount mode"
          value={mountMode}
          onChange={(value) => onMountModeChange(value as MountMode)}
          options={[
            { value: "mounted", label: "Mounted" },
            { value: "handheld", label: "Handheld" },
          ]}
        />
        <SegmentedControl
          label="Phone orientation"
          value={orientation}
          onChange={(value) => onOrientationChange(value as OrientationMode)}
          options={[
            { value: "landscape", label: "Landscape" },
            { value: "portrait", label: "Portrait" },
          ]}
        />
      </div>

      <div className="relative mt-6 overflow-hidden rounded-[2rem] border border-white/60 bg-[radial-gradient(circle_at_50%_16%,rgba(255,255,255,0.92),rgba(255,255,255,0)_38%),linear-gradient(180deg,#f2eadf_0%,#dfd1be_100%)] px-6 py-10">
        <div className="absolute inset-x-0 bottom-0 h-24 bg-[radial-gradient(circle_at_50%_0%,rgba(60,40,24,0.18),transparent_72%)]" />
        <div className="relative mx-auto flex h-[26rem] max-w-sm items-end justify-center">
          <div
            className="absolute bottom-3 h-16 w-56 rounded-[999px] bg-black/18 blur-2xl"
            aria-hidden="true"
          />
          <div
            className="relative h-48 w-64 rounded-[45%_45%_42%_42%/40%_40%_52%_52%] bg-[#242120] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_25px_40px_-24px_rgba(0,0,0,0.75)]"
            style={{ transform: stageTransform.shell }}
          >
            <div className="absolute inset-x-10 top-5 h-12 rounded-[2rem] bg-[#3a3431]" />
            <div className="absolute left-1/2 top-8 h-12 w-24 -translate-x-1/2 rounded-[1.8rem] bg-[#141212]" />
          </div>

          <div
            className="absolute bottom-32 flex flex-col items-center"
            style={{ transform: stageTransform.arm }}
          >
            <div className="h-8 w-16 rounded-full bg-[#1b1a19]" />
            <div className="mt-[-2px] h-16 w-5 rounded-full bg-[#262524]" />
            <div className="mt-[-4px] h-10 w-[4.5rem] rounded-full bg-[#161413]" />
            <div className="mt-[-2px] h-12 w-4 rounded-full bg-[#272523]" />
            <div className="mt-2 h-6 w-20 rounded-full bg-[#111010]" />

            <div
              className={[
                "relative mt-3 flex items-center justify-center rounded-[1.7rem] border border-white/10 bg-[#090c13] shadow-[0_18px_45px_-20px_rgba(0,0,0,0.9)]",
                orientation === "landscape" ? "h-24 w-44" : "h-44 w-24",
              ].join(" ")}
              style={{ transform: stageTransform.screen }}
            >
              <div className="absolute inset-[7px] rounded-[1.4rem] bg-[linear-gradient(180deg,#0a101a_0%,#121a27_100%)]" />
              <div className="absolute inset-[14px] overflow-hidden rounded-[1.1rem] bg-[radial-gradient(circle_at_50%_42%,rgba(72,113,255,0.22),rgba(7,10,18,0.94)_55%)]">
                {mountMode === "mounted" ? (
                  <div className="flex h-full items-center justify-center gap-5">
                    {[0, 1].map((index) => (
                      <div
                        key={index}
                        className="relative h-10 w-10 rounded-full bg-[radial-gradient(circle_at_50%_45%,#e9f4ff_0%,#87a8ff_24%,#2e4fb0_48%,#050a17_74%)] shadow-[0_0_22px_rgba(122,167,255,0.4)]"
                      >
                        <div
                          className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#09101e]"
                          style={{
                            left: stageTransform.pupilX,
                            top: stageTransform.pupilY,
                          }}
                        />
                        <div className="absolute left-[32%] top-[28%] h-2 w-2 rounded-full bg-white/90 blur-[1px]" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="rounded-full border border-dashed border-white/25 px-4 py-2 text-3xs uppercase tracking-[0.24em] text-slate-300">
                      handheld
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Card tone="muted" padding="md" className="bg-white/80">
          <Text variant="caption" tone="muted">
            Head yaw
          </Text>
          <Heading level={3} variant="subtitle" className="mt-1">
            {headPose.yaw.toFixed(1)}°
          </Heading>
        </Card>
        <Card tone="muted" padding="md" className="bg-white/80">
          <Text variant="caption" tone="muted">
            Head pitch
          </Text>
          <Heading level={3} variant="subtitle" className="mt-1">
            {headPose.pitch.toFixed(1)}°
          </Heading>
        </Card>
        <Card tone="muted" padding="md" className="bg-white/80">
          <Text variant="caption" tone="muted">
            Head elbow
          </Text>
          <Heading level={3} variant="subtitle" className="mt-1">
            {headPose.elbow.toFixed(1)}°
          </Heading>
        </Card>
      </div>
    </Card>
  );
}
