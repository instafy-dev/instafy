import type { CapabilityExecutorProviderDefinition } from "@instafy/sdk/capabilities";
import {
  createRobotEmbodimentExecutor,
  type RobotEmbodimentExecutorContext,
} from "./robotCapability";

export interface LocalRobotCapabilityExecutorContext {
  robotEmbodiment: RobotEmbodimentExecutorContext | null;
}

export const ROBOT_EMBODIMENT_FEATURE_SERVICE_ID = "robot.embodiment";

export const LOCAL_ROBOT_CAPABILITY_EXECUTOR_PROVIDER: CapabilityExecutorProviderDefinition<LocalRobotCapabilityExecutorContext> = {
  id: "local_robot_executor",
  title: "Local robot capability executor provider",
  description: "Registers local robot capability executors against the current frontend environment.",
  createExecutors: (context) =>
    context.robotEmbodiment ? [createRobotEmbodimentExecutor(context.robotEmbodiment)] : [],
};
