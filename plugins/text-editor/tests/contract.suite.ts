import { defineContractSuite } from "@reai/app-test/v1";

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.16.0",
  expect: {
    surfaces: ["main"],
    readySurfaces: ["main"],
    intents: ["open-document", "view-diff"],
    forbiddenNetworkRequests: "all",
    noResourcesAfterUnmount: true,
  },
  scenarios: [],
});
