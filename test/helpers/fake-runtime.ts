import { vi } from 'vitest'

import { OUTPUTS } from './operation-outputs.js'

const resolved = (value: unknown) => vi.fn<(...args: any[]) => Promise<any>>(async () => structuredClone(value))

/**
 * A domain runtime whose every method is a mock answering with the operation's valid fixture
 * result, so a call through any interface succeeds unless a test makes a method fail.
 */
export function fakeServiceRuntime() {
  return {
    authStatus: resolved(OUTPUTS.auth_status),
    account: {
      listProjects: resolved(OUTPUTS.list_projects),
      findProject: resolved(OUTPUTS.list_projects.projects[0]),
    },
    projects: {
      createProject: resolved(OUTPUTS.create_project),
      cloneProject: resolved(OUTPUTS.clone_project),
      importProjectZip: resolved(OUTPUTS.import_project_zip),
      downloadProjectZip: resolved(OUTPUTS.download_project_zip),
      manageProject: resolved(OUTPUTS.manage_project),
      updateProjectSettings: resolved(OUTPUTS.update_project_settings),
    },
    entities: {
      getProjectTree: resolved(OUTPUTS.get_project_tree),
      manageEntity: resolved(OUTPUTS.manage_entity),
      uploadFile: resolved(OUTPUTS.upload_file),
      downloadFile: resolved(OUTPUTS.download_file),
    },
    documents: { readFile: resolved(OUTPUTS.read_file), writeFile: resolved(OUTPUTS.write_file) },
    createFile: resolved(OUTPUTS.create_file),
    sections: {
      getFullDocument: resolved(OUTPUTS.get_full_document),
      getSections: resolved(OUTPUTS.get_sections),
      getSectionContent: resolved(OUTPUTS.get_section_content),
      writeSection: resolved(OUTPUTS.write_section),
    },
    compile: {
      compileProject: resolved(OUTPUTS.compile_project),
      stopCompile: resolved(OUTPUTS.stop_compile),
      getCompileLog: resolved(OUTPUTS.get_compile_log),
      downloadCompileOutput: resolved(OUTPUTS.download_compile_output),
      readCompileOutput: resolved({}),
    },
    comments: {
      listComments: resolved(OUTPUTS.list_comments),
      replyToComment: resolved(OUTPUTS.reply_to_comment),
      addComment: resolved(OUTPUTS.add_comment),
      setCommentStatus: resolved(OUTPUTS.set_comment_status),
    },
    trackedChanges: {
      listTrackedChanges: resolved(OUTPUTS.list_tracked_changes),
      manageTrackedChanges: resolved(OUTPUTS.manage_tracked_changes),
    },
    history: { monitorProjectHistory: resolved(OUTPUTS.monitor_project_history) },
    sync: {
      planSync: resolved(OUTPUTS.plan_sync),
      syncDirectory: resolved(OUTPUTS.sync_directory),
      deleteEntities: resolved(OUTPUTS.delete_entities),
      batchUpload: resolved(OUTPUTS.batch_upload),
    },
    close: vi.fn(async () => undefined),
  }
}
