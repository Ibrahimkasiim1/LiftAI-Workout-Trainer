/**
 * withRestTimerWidget
 *
 * Expo config plugin that:
 *   1. Copies native sources into the (regenerated-by-prebuild) ios/ folder.
 *   2. Adds the LiftLiveActivityModule (Swift + Obj-C bridge) to the main app target.
 *   3. Creates a RestTimerWidget app-extension target with a Live Activity widget.
 *   4. Shares RestTimerAttributes.swift between both targets via dual PBXBuildFile
 *      entries on a single PBXFileReference (required so ActivityKit matches the
 *      Swift type across the app/extension boundary).
 *   5. Embeds the extension into the main app, adds required frameworks, sets
 *      build settings (deployment target 16.2, App Group entitlement, etc.).
 *   6. Ensures the bridging header re-exports React headers Swift needs.
 *
 * Reference layout after running `expo prebuild`:
 *   ios/LiftAI/LiftLiveActivityModule.swift   (main target)
 *   ios/LiftAI/LiftLiveActivityModule.m       (main target)
 *   ios/Shared/RestTimerAttributes.swift      (shared by both targets)
 *   ios/RestTimerWidget/...                   (widget extension target)
 */

const fs = require('fs');
const path = require('path');
const {
  withDangerousMod,
  withXcodeProject,
  withEntitlementsPlist,
  withInfoPlist,
} = require('@expo/config-plugins');

const WIDGET_NAME = 'RestTimerWidget';
const APP_GROUP = 'group.com.example.liftai';
const DEPLOYMENT_TARGET = '16.2';

const TEMPLATES_DIR = path.join(__dirname, 'withRestTimerWidget', 'templates');

// ----------------------------------------------------------------------------
// File-system step: copy templates into ios/ after prebuild has regenerated it.
// ----------------------------------------------------------------------------

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

const withCopyNativeSources = (config) =>
  withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const iosRoot = cfg.modRequest.platformProjectRoot;
      const appName = cfg.modRequest.projectName; // "LiftAI"

      // 1. Native module → main app folder
      fs.copyFileSync(
        path.join(TEMPLATES_DIR, 'LiftLiveActivityModule.swift'),
        path.join(iosRoot, appName, 'LiftLiveActivityModule.swift'),
      );
      fs.copyFileSync(
        path.join(TEMPLATES_DIR, 'LiftLiveActivityModule.m'),
        path.join(iosRoot, appName, 'LiftLiveActivityModule.m'),
      );

      // 2. Shared ActivityAttributes → ios/Shared/
      const sharedDir = path.join(iosRoot, 'Shared');
      if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });
      fs.copyFileSync(
        path.join(TEMPLATES_DIR, 'RestTimerAttributes.swift'),
        path.join(sharedDir, 'RestTimerAttributes.swift'),
      );

      // 3. Widget extension folder
      copyDirSync(path.join(TEMPLATES_DIR, WIDGET_NAME), path.join(iosRoot, WIDGET_NAME));

      // 4. Bridging header — make sure React headers Swift relies on are re-exported.
      const bridgingHeaderPath = path.join(iosRoot, appName, `${appName}-Bridging-Header.h`);
      if (fs.existsSync(bridgingHeaderPath)) {
        let header = fs.readFileSync(bridgingHeaderPath, 'utf8');
        const required = [
          '#import <React/RCTBridgeModule.h>',
          '#import <React/RCTEventEmitter.h>',
        ];
        let mutated = false;
        for (const line of required) {
          if (!header.includes(line)) {
            header += `\n${line}\n`;
            mutated = true;
          }
        }
        if (mutated) fs.writeFileSync(bridgingHeaderPath, header);
      }

      return cfg;
    },
  ]);

// ----------------------------------------------------------------------------
// Entitlements: ensure App Group is present on the main app target.
// (app.config.js already declares it, but we re-assert here so the plugin is
//  self-contained.)
// ----------------------------------------------------------------------------

const withMainAppEntitlements = (config) =>
  withEntitlementsPlist(config, (cfg) => {
    const key = 'com.apple.security.application-groups';
    const groups = new Set(cfg.modResults[key] || []);
    groups.add(APP_GROUP);
    cfg.modResults[key] = Array.from(groups);
    return cfg;
  });

const withLiveActivityInfoPlist = (config) =>
  withInfoPlist(config, (cfg) => {
    cfg.modResults.NSSupportsLiveActivities = true;
    cfg.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    return cfg;
  });

// ----------------------------------------------------------------------------
// Xcode project surgery.
// ----------------------------------------------------------------------------

const withXcodeWidgetTarget = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const mainAppName = cfg.modRequest.projectName; // "LiftAI"
    const mainBundleId = cfg.ios?.bundleIdentifier;
    if (!mainBundleId) throw new Error('[withRestTimerWidget] ios.bundleIdentifier missing');
    const widgetBundleId = `${mainBundleId}.${WIDGET_NAME}`;

    const mainTargetUuid = findMainTargetUuid(project, mainAppName);
    if (!mainTargetUuid) {
      throw new Error(`[withRestTimerWidget] could not find main target ${mainAppName}`);
    }

    // 1. Add native module sources to main target.
    addSourceFileToTarget(
      project,
      `${mainAppName}/LiftLiveActivityModule.swift`,
      mainTargetUuid,
      mainAppName,
    );
    addSourceFileToTarget(
      project,
      `${mainAppName}/LiftLiveActivityModule.m`,
      mainTargetUuid,
      mainAppName,
    );

    // 2. Add shared RestTimerAttributes to main target (we'll add to widget below
    //    via a second PBXBuildFile pointing at the same file ref).
    const sharedFileRef = addSourceFileToTarget(
      project,
      'Shared/RestTimerAttributes.swift',
      mainTargetUuid,
      'Shared',
    );

    // 3. Create the widget extension target.
    const { targetUuid: widgetTargetUuid, groupUuid: widgetGroupUuid } = createWidgetExtension(
      project,
      {
        targetName: WIDGET_NAME,
        bundleId: widgetBundleId,
      },
    );

    // 4. Add widget Swift sources to widget target.
    for (const fileName of [
      'RestTimerWidgetBundle.swift',
      'RestTimerLiveActivityWidget.swift',
      'SkipRestIntent.swift',
    ]) {
      addSourceFileToTarget(
        project,
        `${WIDGET_NAME}/${fileName}`,
        widgetTargetUuid,
        WIDGET_NAME,
        widgetGroupUuid,
      );
    }

    // 5. Share RestTimerAttributes with widget target via second build file.
    addExistingFileRefToTargetSources(project, sharedFileRef, widgetTargetUuid);

    // 6. Add Info.plist file ref (no build phase) and Assets resource.
    addPlainFileRef(project, `${WIDGET_NAME}/Info.plist`, widgetGroupUuid);
    addPlainFileRef(
      project,
      `${WIDGET_NAME}/${WIDGET_NAME}.entitlements`,
      widgetGroupUuid,
    );
    addResourceFileToTarget(
      project,
      `${WIDGET_NAME}/Assets.xcassets`,
      widgetTargetUuid,
      widgetGroupUuid,
    );

    // 7. Add system frameworks to widget target.
    addFrameworksToTarget(project, widgetTargetUuid, [
      'SwiftUI.framework',
      'WidgetKit.framework',
      'ActivityKit.framework',
      'AppIntents.framework',
    ]);

    // 8. Embed widget extension into main app.
    addEmbedExtensionsBuildPhase(project, mainTargetUuid, widgetTargetUuid, WIDGET_NAME);

    // 9. Configure widget target build settings.
    configureWidgetBuildSettings(project, WIDGET_NAME, widgetBundleId);

    return cfg;
  });

// ----------------------------------------------------------------------------
// xcode helpers
// ----------------------------------------------------------------------------

function findMainTargetUuid(project, appName) {
  const targets = project.hash.project.objects.PBXNativeTarget || {};
  for (const uuid of Object.keys(targets)) {
    if (uuid.endsWith('_comment')) continue;
    const t = targets[uuid];
    if (t.productType && t.productType.replace(/"/g, '') === 'com.apple.product-type.application') {
      const name = (t.name || '').replace(/"/g, '');
      if (name === appName) return uuid;
    }
  }
  return null;
}

function getMainGroupUuid(project) {
  const root = project.hash.project.objects.PBXProject;
  for (const k of Object.keys(root)) {
    if (k.endsWith('_comment')) continue;
    return root[k].mainGroup;
  }
  return null;
}

function findOrCreateGroupUnderRoot(project, groupName, groupPath) {
  const groups = project.hash.project.objects.PBXGroup || {};
  const rootGroupUuid = getMainGroupUuid(project);
  const rootGroup = groups[rootGroupUuid];

  // Check existing children for the group name.
  for (const child of rootGroup.children || []) {
    const g = groups[child.value];
    if (!g) continue;
    const name = (g.name || g.path || '').replace(/"/g, '');
    if (name === groupName) {
      return child.value;
    }
  }
  // Create. Pass null for path so the group is purely organizational and
  // children's paths (e.g. "RestTimerWidget/Foo.swift") resolve from project
  // root instead of being doubled (RestTimerWidget/RestTimerWidget/Foo.swift).
  const newGroup = project.addPbxGroup([], groupName, '""', '"<group>"');
  // xcode lib still writes `path = ""`; strip it so Xcode treats this as a
  // name-only group like the existing main app group.
  const created = project.hash.project.objects.PBXGroup[newGroup.uuid];
  if (created && Object.prototype.hasOwnProperty.call(created, 'path')) {
    delete created.path;
  }
  rootGroup.children.push({
    value: newGroup.uuid,
    comment: groupName,
  });
  return newGroup.uuid;
}

/**
 * Add a Swift/Obj-C source file to a target. Returns the file reference UUID
 * (so the same file can be re-added to additional targets).
 */
function addSourceFileToTarget(project, relativePath, targetUuid, parentGroupName, explicitGroupUuid) {
  const groupUuid =
    explicitGroupUuid ||
    findOrCreateGroupUnderRoot(project, parentGroupName, parentGroupName);

  const pbxFile = project.addSourceFile(
    relativePath,
    { target: targetUuid },
    groupUuid,
  );
  return pbxFile.fileRef;
}

function addPlainFileRef(project, relativePath, groupUuid) {
  // addFile creates a PBXFileReference + adds to group, but does NOT add to a build phase.
  const pbxFile = project.addFile(relativePath, groupUuid, {
    lastKnownFileType: relativePath.endsWith('.plist')
      ? 'text.plist.xml'
      : relativePath.endsWith('.entitlements')
      ? 'text.plist.entitlements'
      : undefined,
  });
  return pbxFile && pbxFile.fileRef;
}

function addResourceFileToTarget(project, relativePath, targetUuid, groupUuid) {
  // The xcode lib's addResourceFile crashes if there's no top-level "Resources"
  // PBXGroup, so we add the file ref + build file manually.
  const objects = project.hash.project.objects;
  const fileName = path.basename(relativePath);

  const fileRefUuid = project.generateUuid();
  objects.PBXFileReference[fileRefUuid] = {
    isa: 'PBXFileReference',
    lastKnownFileType: relativePath.endsWith('.xcassets')
      ? 'folder.assetcatalog'
      : undefined,
    name: `"${fileName}"`,
    path: `"${fileName}"`,
    sourceTree: '"<group>"',
  };
  objects.PBXFileReference[`${fileRefUuid}_comment`] = fileName;

  const group = objects.PBXGroup[groupUuid];
  group.children = group.children || [];
  group.children.push({ value: fileRefUuid, comment: fileName });

  const buildFileUuid = project.generateUuid();
  const buildComment = `${fileName} in Resources`;
  objects.PBXBuildFile[buildFileUuid] = {
    isa: 'PBXBuildFile',
    fileRef: fileRefUuid,
    fileRef_comment: fileName,
  };
  objects.PBXBuildFile[`${buildFileUuid}_comment`] = buildComment;

  const target = objects.PBXNativeTarget[targetUuid];
  const resourcesPhaseEntry = target.buildPhases.find((p) => p.comment === 'Resources');
  if (!resourcesPhaseEntry) {
    throw new Error('[withRestTimerWidget] target missing Resources build phase');
  }
  const resourcesPhase = objects.PBXResourcesBuildPhase[resourcesPhaseEntry.value];
  resourcesPhase.files.push({ value: buildFileUuid, comment: buildComment });

  return fileRefUuid;
}

/**
 * Given an existing PBXFileReference UUID, create a new PBXBuildFile pointing
 * at it and append to the named target's Sources phase. Used to share
 * RestTimerAttributes.swift between the app and the widget extension targets.
 */
function addExistingFileRefToTargetSources(project, fileRefUuid, targetUuid) {
  const objects = project.hash.project.objects;
  const target = objects.PBXNativeTarget[targetUuid];
  const sourcesPhaseEntry = target.buildPhases.find((p) => p.comment === 'Sources');
  if (!sourcesPhaseEntry) {
    throw new Error('[withRestTimerWidget] target missing Sources build phase');
  }
  const sourcesPhase = objects.PBXSourcesBuildPhase[sourcesPhaseEntry.value];

  // Look up the file name from the file ref so the comment is sensible.
  const fileRefObj = objects.PBXFileReference[fileRefUuid];
  const fileName = (fileRefObj.name || fileRefObj.path || 'file').replace(/"/g, '');
  const comment = `${fileName} in Sources`;

  const buildFileUuid = project.generateUuid();
  objects.PBXBuildFile[buildFileUuid] = {
    isa: 'PBXBuildFile',
    fileRef: fileRefUuid,
    fileRef_comment: fileName,
  };
  objects.PBXBuildFile[`${buildFileUuid}_comment`] = comment;

  sourcesPhase.files.push({ value: buildFileUuid, comment });
}

function addFrameworksToTarget(project, targetUuid, frameworkNames) {
  const objects = project.hash.project.objects;
  const target = objects.PBXNativeTarget[targetUuid];
  const frameworksPhaseEntry = target.buildPhases.find((p) => p.comment === 'Frameworks');
  if (!frameworksPhaseEntry) {
    throw new Error('[withRestTimerWidget] target missing Frameworks build phase');
  }
  const frameworksPhase = objects.PBXFrameworksBuildPhase[frameworksPhaseEntry.value];

  // Find or create a "Frameworks" group under the main group to host file refs.
  const frameworksGroupUuid = findOrCreateGroupUnderRoot(project, 'Frameworks');

  for (const fwName of frameworkNames) {
    const fileRefUuid = project.generateUuid();
    objects.PBXFileReference[fileRefUuid] = {
      isa: 'PBXFileReference',
      lastKnownFileType: 'wrapper.framework',
      name: fwName,
      path: `System/Library/Frameworks/${fwName}`,
      sourceTree: 'SDKROOT',
    };
    objects.PBXFileReference[`${fileRefUuid}_comment`] = fwName;

    // Add to Frameworks group for visibility.
    const fwGroup = objects.PBXGroup[frameworksGroupUuid];
    fwGroup.children = fwGroup.children || [];
    fwGroup.children.push({ value: fileRefUuid, comment: fwName });

    const buildFileUuid = project.generateUuid();
    objects.PBXBuildFile[buildFileUuid] = {
      isa: 'PBXBuildFile',
      fileRef: fileRefUuid,
      fileRef_comment: fwName,
    };
    const comment = `${fwName} in Frameworks`;
    objects.PBXBuildFile[`${buildFileUuid}_comment`] = comment;

    frameworksPhase.files.push({ value: buildFileUuid, comment });
  }
}

function createWidgetExtension(project, { targetName, bundleId }) {
  // Group for the extension's source files.
  const groupUuid = findOrCreateGroupUnderRoot(project, targetName, targetName);

  // xcode lib's addTarget creates the PBXNativeTarget + build configuration list,
  // but does NOT create build phases — we add them explicitly below.
  const target = project.addTarget(targetName, 'app_extension', targetName, bundleId);

  project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

  return { targetUuid: target.uuid, groupUuid };
}

function addEmbedExtensionsBuildPhase(project, mainTargetUuid, widgetTargetUuid, widgetName) {
  const objects = project.hash.project.objects;
  const mainTarget = objects.PBXNativeTarget[mainTargetUuid];

  // 1. Target dependency: main app must build the widget first.
  const projectRoot = objects.PBXProject;
  const projectUuid = Object.keys(projectRoot).find((k) => !k.endsWith('_comment'));

  const proxyUuid = project.generateUuid();
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};
  objects.PBXContainerItemProxy[proxyUuid] = {
    isa: 'PBXContainerItemProxy',
    containerPortal: projectUuid,
    containerPortal_comment: 'Project object',
    proxyType: 1,
    remoteGlobalIDString: widgetTargetUuid,
    remoteInfo: `"${widgetName}"`,
  };
  objects.PBXContainerItemProxy[`${proxyUuid}_comment`] = 'PBXContainerItemProxy';

  const depUuid = project.generateUuid();
  objects.PBXTargetDependency = objects.PBXTargetDependency || {};
  objects.PBXTargetDependency[depUuid] = {
    isa: 'PBXTargetDependency',
    target: widgetTargetUuid,
    target_comment: `"${widgetName}"`,
    targetProxy: proxyUuid,
    targetProxy_comment: 'PBXContainerItemProxy',
  };
  objects.PBXTargetDependency[`${depUuid}_comment`] = 'PBXTargetDependency';

  mainTarget.dependencies = mainTarget.dependencies || [];
  mainTarget.dependencies.push({ value: depUuid, comment: 'PBXTargetDependency' });

  // 2. xcode-lib's addTarget('app_extension', ...) already added a generic
  //    "Copy Files" PBXCopyFilesBuildPhase with dstSubfolderSpec=13 (PlugIns)
  //    on the main target containing our .appex. Find it and rename it to
  //    "Embed Foundation Extensions" so it matches Apple's conventional name.
  const copyPhases = objects.PBXCopyFilesBuildPhase || {};
  for (const key of Object.keys(copyPhases)) {
    if (key.endsWith('_comment')) continue;
    const phase = copyPhases[key];
    if (
      phase.dstSubfolderSpec === 13 &&
      (phase.name || '').replace(/"/g, '') === 'Copy Files'
    ) {
      phase.name = '"Embed Foundation Extensions"';
      copyPhases[`${key}_comment`] = 'Embed Foundation Extensions';
      // Also update the entry on the main target's buildPhases array.
      const entry = mainTarget.buildPhases.find((p) => p.value === key);
      if (entry) entry.comment = 'Embed Foundation Extensions';
      // Mark RemoveHeadersOnCopy on the embedded build file (Apple convention).
      for (const f of phase.files || []) {
        const bf = objects.PBXBuildFile[f.value];
        if (bf) {
          bf.settings = bf.settings || {};
          bf.settings.ATTRIBUTES = ['RemoveHeadersOnCopy'];
        }
      }
    }
  }
}

function configureWidgetBuildSettings(project, targetName, bundleId) {
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    if (key.endsWith('_comment')) continue;
    const config = configurations[key];
    if (!config.buildSettings) continue;
    const productName = (config.buildSettings.PRODUCT_NAME || '').replace(/"/g, '');
    if (productName !== targetName) continue;

    const bs = config.buildSettings;
    bs.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = 'AccentColor';
    bs.ASSETCATALOG_COMPILER_WIDGET_BACKGROUND_COLOR_NAME = 'WidgetBackground';
    bs.CLANG_ANALYZER_NONNULL = 'YES';
    bs.CLANG_CXX_LANGUAGE_STANDARD = '"gnu++20"';
    bs.CLANG_ENABLE_MODULES = 'YES';
    bs.CLANG_ENABLE_OBJC_ARC = 'YES';
    bs.CODE_SIGN_ENTITLEMENTS = `${targetName}/${targetName}.entitlements`;
    bs.CODE_SIGN_STYLE = 'Automatic';
    bs.CURRENT_PROJECT_VERSION = '1';
    bs.DEBUG_INFORMATION_FORMAT = '"dwarf-with-dsym"';
    bs.GCC_C_LANGUAGE_STANDARD = 'gnu17';
    bs.GENERATE_INFOPLIST_FILE = 'NO';
    bs.INFOPLIST_FILE = `${targetName}/Info.plist`;
    bs.INFOPLIST_KEY_CFBundleDisplayName = targetName;
    bs.INFOPLIST_KEY_NSHumanReadableCopyright = '""';
    bs.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
    bs.LD_RUNPATH_SEARCH_PATHS =
      '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"';
    bs.MARKETING_VERSION = '1.0';
    bs.MTL_ENABLE_DEBUG_INFO = 'INCLUDE_SOURCE';
    bs.MTL_FAST_MATH = 'YES';
    bs.PRODUCT_BUNDLE_IDENTIFIER = bundleId;
    bs.PRODUCT_NAME = '"$(TARGET_NAME)"';
    bs.SKIP_INSTALL = 'YES'; // extensions are bundled, not installed standalone
    bs.SWIFT_ACTIVE_COMPILATION_CONDITIONS = 'DEBUG';
    bs.SWIFT_EMIT_LOC_STRINGS = 'YES';
    bs.SWIFT_OPTIMIZATION_LEVEL =
      config.name === 'Release' ? '"-O"' : '"-Onone"';
    bs.SWIFT_VERSION = '5.0';
    bs.TARGETED_DEVICE_FAMILY = '"1,2"';
  }
}

// ----------------------------------------------------------------------------
// Plugin entry.
// ----------------------------------------------------------------------------

module.exports = function withRestTimerWidget(config) {
  config = withLiveActivityInfoPlist(config);
  config = withMainAppEntitlements(config);
  config = withCopyNativeSources(config);
  config = withXcodeWidgetTarget(config);
  return config;
};
