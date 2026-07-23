import { describe, expect, it } from "vitest";
import type { ProjectListItem } from "../useProjects";
import {
  filterAccessibleProjectsByOrg,
  mergeControllerProjects,
  mergeRemoteProjectSources,
} from "../useMergedControllerProjects";

function createLocalProject(overrides: Partial<ProjectListItem>): ProjectListItem {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Local space",
    orgId: "22222222-2222-2222-2222-222222222222",
    orgName: "Local org",
    state: {} as ProjectListItem["state"],
    ...overrides,
  };
}

describe("mergeControllerProjects", () => {
  it("adds remote-only spaces with controller names and orgs", () => {
    const merged = mergeControllerProjects([], [
      {
        projectId: "33333333-3333-3333-3333-333333333333",
        projectName: "Camera rig",
        orgId: "44444444-4444-4444-4444-444444444444",
        orgName: "Studio team",
      },
    ]);

    expect(merged).toEqual([
      expect.objectContaining({
        id: "33333333-3333-3333-3333-333333333333",
        name: "Camera rig",
        orgId: "44444444-4444-4444-4444-444444444444",
        orgName: "Studio team",
        isRemoteOnly: true,
        state: null,
      }),
    ]);
  });

  it("keeps local names while backfilling controller org metadata", () => {
    const merged = mergeControllerProjects(
      [
        createLocalProject({
          id: "55555555-5555-5555-5555-555555555555",
          name: "Local draft name",
          orgId: null,
          orgName: "Personal",
        }),
      ],
      [
        {
          projectId: "55555555-5555-5555-5555-555555555555",
          projectName: "Remote canonical name",
          orgId: "66666666-6666-6666-6666-666666666666",
          orgName: "Shared org",
        },
      ],
    );

    expect(merged).toEqual([
      expect.objectContaining({
        id: "55555555-5555-5555-5555-555555555555",
        name: "Local draft name",
        orgId: "66666666-6666-6666-6666-666666666666",
        orgName: "Shared org",
        isRemoteOnly: false,
      }),
    ]);
  });
});

describe("mergeRemoteProjectSources", () => {
  it("adds a requested project summary when the bulk list has not loaded it yet", () => {
    expect(
      mergeRemoteProjectSources([], {
        projectId: "77777777-7777-4777-8777-777777777777",
        projectName: "Requested space",
        orgId: "88888888-8888-4888-8888-888888888888",
        orgName: "Personal team",
      }),
    ).toEqual([
      expect.objectContaining({
        projectId: "77777777-7777-4777-8777-777777777777",
        projectName: "Requested space",
      }),
    ]);
  });

  it("lets the requested project summary overwrite stale bulk-list metadata", () => {
    const merged = mergeControllerProjects(
      [],
      mergeRemoteProjectSources(
        [
          {
            projectId: "99999999-9999-4999-8999-999999999999",
            projectName: null,
            orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            orgName: "Personal team",
          },
        ],
        {
          projectId: "99999999-9999-4999-8999-999999999999",
          projectName: "Recovered space",
          orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          orgName: "Personal team",
        },
      ),
    );

    expect(merged).toEqual([
      expect.objectContaining({
        id: "99999999-9999-4999-8999-999999999999",
        name: "Recovered space",
      }),
    ]);
  });
});

describe("filterAccessibleProjectsByOrg", () => {
  const directMembershipProject = {
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectName: "Directly shared space",
    orgId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    orgName: "External team",
  };
  const orgMembershipProject = {
    projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    projectName: "Team space",
    orgId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    orgName: "My team",
  };

  it("keeps directly shared spaces in all-team discovery", () => {
    expect(
      filterAccessibleProjectsByOrg(
        [directMembershipProject, orgMembershipProject],
        null,
      ),
    ).toEqual([directMembershipProject, orgMembershipProject]);
  });

  it("can scope accessible discovery to a direct membership's organization", () => {
    expect(
      filterAccessibleProjectsByOrg(
        [directMembershipProject, orgMembershipProject],
        directMembershipProject.orgId,
      ),
    ).toEqual([directMembershipProject]);
  });
});
