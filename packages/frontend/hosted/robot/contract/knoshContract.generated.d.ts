export type KnoshPrimaryControl = {
  readonly type: string;
  readonly controller: string;
  readonly peer: string;
  readonly serialization: string;
  readonly updateRateHz: number;
  readonly commandStalenessTimeoutMs: number;
  readonly serviceUuid: string | null;
  readonly commandCharacteristicUuid: string | null;
  readonly telemetryCharacteristicUuid: string | null;
  readonly statusCharacteristicUuid: string | null;
  readonly maxPayloadBytes: number | null;
  readonly preferredMtuBytes: number | null;
  readonly writeMode: string | null;
  readonly telemetryMode: string | null;
  readonly ackPolicy: string | null;
  readonly framing: string | null;
};

export type KnoshContract = {
  readonly robotId: string;
  readonly robotName: string;
  readonly expectedDeviceName: string;
  readonly primaryControl: KnoshPrimaryControl;
  readonly envelopeKinds: { readonly command: string; readonly telemetry: string };
  readonly jointNames: readonly string[];
  readonly commandNames: readonly string[];
  readonly telemetryNames: readonly string[];
  readonly modulePortNames: readonly string[];
};

export const ROBOT_ID: string;
export const ROBOT_NAME: string;
export const EXPECTED_DEVICE_NAME: string;
export const PRIMARY_CONTROL: KnoshPrimaryControl;
export const PRIMARY_CONTROL_TYPE: string;
export const PRIMARY_CONTROL_CONTROLLER: string;
export const PRIMARY_CONTROL_PEER: string;
export const PRIMARY_CONTROL_SERIALIZATION: string;
export const PRIMARY_CONTROL_UPDATE_RATE_HZ: number;
export const PRIMARY_CONTROL_COMMAND_STALENESS_TIMEOUT_MS: number;
export const PRIMARY_CONTROL_SERVICE_UUID: string | null;
export const PRIMARY_CONTROL_COMMAND_CHARACTERISTIC_UUID: string | null;
export const PRIMARY_CONTROL_TELEMETRY_CHARACTERISTIC_UUID: string | null;
export const PRIMARY_CONTROL_STATUS_CHARACTERISTIC_UUID: string | null;
export const PRIMARY_CONTROL_MAX_PAYLOAD_BYTES: number | null;
export const PRIMARY_CONTROL_PREFERRED_MTU_BYTES: number | null;
export const PRIMARY_CONTROL_WRITE_MODE: string | null;
export const PRIMARY_CONTROL_TELEMETRY_MODE: string | null;
export const PRIMARY_CONTROL_ACK_POLICY: string | null;
export const PRIMARY_CONTROL_FRAMING: string | null;
export const COMMAND_ENVELOPE_KIND: string;
export const TELEMETRY_ENVELOPE_KIND: string;
export const JOINT_NAMES: readonly string[];
export const COMMAND_NAMES: readonly string[];
export const TELEMETRY_NAMES: readonly string[];
export const MODULE_PORT_NAMES: readonly string[];
export type KnoshJoint = {
  readonly name: string;
  readonly axis: string;
  readonly minDeg: number;
  readonly maxDeg: number;
  readonly homeDeg: number;
};
export type KnoshPose = {
  readonly name: string;
  readonly jointsDeg: Readonly<Record<string, number>>;
};
export type KnoshBehaviorStep = {
  readonly pose: string;
  readonly durationS: number;
  readonly faceMood: string | null;
};
export type KnoshBehavior = {
  readonly name: string;
  readonly steps: readonly KnoshBehaviorStep[];
};
export type KnoshSkillPrecondition = {
  readonly kind: "pose_near" | "not_pose_near";
  readonly pose: string;
  readonly toleranceDeg: number;
};
export type KnoshSkillParam =
  | {
      readonly name: string;
      readonly kind: "number";
      readonly min: number;
      readonly max: number;
      readonly required: boolean;
      readonly default: number | null;
    }
  | {
      readonly name: string;
      readonly kind: "enum";
      readonly values: readonly string[];
      readonly valuesFrom: string | null;
      readonly required: boolean;
      readonly default: string | null;
    };
export type KnoshSkillCommandArg =
  | number
  | string
  | {
      readonly pose: string;
      readonly joint: string;
      readonly plus: string | null;
      readonly clampToLimits: boolean;
    };
export type KnoshSkillStep =
  | { readonly behavior: string }
  | { readonly pose: string; readonly durationS: number }
  | {
      readonly command: string;
      readonly args: Readonly<Record<string, KnoshSkillCommandArg>>;
    }
  | {
      readonly driveTo: { readonly location: string; readonly finalYaw: boolean };
    };
export type KnoshSkillPostcondition =
  | {
      readonly kind: "joint_near";
      readonly joint: string;
      readonly target: number | string;
      readonly toleranceDeg: number;
    }
  | {
      readonly kind: "position_near";
      readonly location: string;
      readonly toleranceM: number;
    };
export type KnoshSkill = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly safetyClass: string;
  readonly preconditions: readonly KnoshSkillPrecondition[];
  readonly params: readonly KnoshSkillParam[];
  readonly steps: readonly KnoshSkillStep[];
  readonly postconditions: readonly KnoshSkillPostcondition[];
  readonly timeoutS: number;
};
export type KnoshWorldLocation = {
  readonly name: string;
  readonly xM: number;
  readonly yM: number;
  readonly yawDeg: number | null;
  readonly description: string;
};
export type KnoshWorld = {
  readonly id: string;
  readonly frame: string;
  readonly locations: readonly KnoshWorldLocation[];
};
export const JOINTS: readonly KnoshJoint[];
export const POSES: readonly KnoshPose[];
export const BEHAVIORS: readonly KnoshBehavior[];
export const SKILLS: readonly KnoshSkill[];
export const WORLD: KnoshWorld | null;
export const COMMAND_NAME_SET_BASE_TWIST: string;
export const COMMAND_NAME_SET_HEAD_POSE: string;
export const COMMAND_NAME_STOP_ALL_MOTION: string;
export const COMMAND_NAME_MODULE_WRITE: string;
export const COMMAND_NAME_CONTROLLER_PATCH_STAGE: string;
export const COMMAND_NAME_CONTROLLER_PATCH_ACTIVATE: string;
export const COMMAND_NAME_CONTROLLER_PATCH_ROLLBACK: string;
export const KNOSH_CONTRACT: KnoshContract;
