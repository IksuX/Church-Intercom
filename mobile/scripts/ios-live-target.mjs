// Dodaje do projektu Xcode (ios/App/App.xcodeproj, generowany przez Capacitor) rozszerzenie InterkomLive – kartę na
// ekranie blokady. Bezpieczne do wielokrotnego uruchamiania: istniejący cel tylko dostaje aktualny Bundle ID i zespół.
import fs from 'node:fs';

const file = process.argv[2];
let s = fs.readFileSync(file, 'utf8');
const appId = s.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/)?.[1].replace(/"/g, '');
if (!appId) throw new Error('brak Bundle ID aplikacji');
const ID = (n) => '1A1C0DE0000000000000010' + n.toString(16).toUpperCase();
const APP = '504EC3031FED79650016851F', PROJECT = '504EC2FC1FED79650016851F', MAIN = '504EC2FB1FED79650016851F', PRODUCTS = '504EC3051FED79650016851F';

if (!s.includes('InterkomLive.appex')) {
  const put = (re, text, what) => { if (!re.test(s)) throw new Error('nie znaleziono miejsca: ' + what); s = s.replace(re, (m) => m + text); };
  const section = (name, body) => {
    const begin = `/* Begin ${name} section */\n`;
    if (s.includes(begin)) s = s.replace(begin, begin + body);
    else s = s.replace('/* Begin PBXProject section */', `${begin}${body}/* End ${name} section */\n\n/* Begin PBXProject section */`);
  };
  section('PBXBuildFile', `\t\t${ID(0)} /* InterkomLive.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ID(1)} /* InterkomLive.swift */; };
\t\t${ID(2)} /* InterkomLive.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${ID(3)} /* InterkomLive.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };\n`);
  section('PBXFileReference', `\t\t${ID(1)} /* InterkomLive.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = InterkomLive.swift; sourceTree = "<group>"; };
\t\t${ID(3)} /* InterkomLive.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = InterkomLive.appex; sourceTree = BUILT_PRODUCTS_DIR; };\n`);
  section('PBXGroup', `\t\t${ID(4)} /* InterkomLive */ = {isa = PBXGroup; children = (${ID(1)} /* InterkomLive.swift */, ); path = InterkomLive; sourceTree = "<group>"; };\n`);
  put(new RegExp(`${MAIN} = \\{\\s*isa = PBXGroup;\\s*children = \\(\\n`), `\t\t\t\t${ID(4)} /* InterkomLive */,\n`, 'grupa główna');
  put(new RegExp(`${PRODUCTS} /\\* Products \\*/ = \\{\\s*isa = PBXGroup;\\s*children = \\(\\n`), `\t\t\t\t${ID(3)} /* InterkomLive.appex */,\n`, 'Products');
  section('PBXSourcesBuildPhase', `\t\t${ID(5)} /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${ID(0)} /* InterkomLive.swift in Sources */, ); runOnlyForDeploymentPostprocessing = 0; };\n`);
  section('PBXFrameworksBuildPhase', `\t\t${ID(6)} /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };\n`);
  section('PBXCopyFilesBuildPhase', `\t\t${ID(7)} /* Embed Foundation Extensions */ = {isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = ""; dstSubfolderSpec = 13; files = (${ID(2)} /* InterkomLive.appex in Embed Foundation Extensions */, ); name = "Embed Foundation Extensions"; runOnlyForDeploymentPostprocessing = 0; };\n`);
  section('PBXContainerItemProxy', `\t\t${ID(8)} /* PBXContainerItemProxy */ = {isa = PBXContainerItemProxy; containerPortal = ${PROJECT} /* Project object */; proxyType = 1; remoteGlobalIDString = ${ID(10)}; remoteInfo = InterkomLive; };\n`);
  section('PBXTargetDependency', `\t\t${ID(9)} /* PBXTargetDependency */ = {isa = PBXTargetDependency; target = ${ID(10)} /* InterkomLive */; targetProxy = ${ID(8)} /* PBXContainerItemProxy */; };\n`);
  section('PBXNativeTarget', `\t\t${ID(10)} /* InterkomLive */ = {isa = PBXNativeTarget; buildConfigurationList = ${ID(11)} /* Build configuration list for PBXNativeTarget "InterkomLive" */; buildPhases = (${ID(5)} /* Sources */, ${ID(6)} /* Frameworks */, ); buildRules = (); dependencies = (); name = InterkomLive; productName = InterkomLive; productReference = ${ID(3)} /* InterkomLive.appex */; productType = "com.apple.product-type.app-extension"; };\n`);
  const cfg = (id, name) => `\t\t${id} /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tAPPLICATION_EXTENSION_API_ONLY = YES;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tINFOPLIST_FILE = InterkomLive/Info.plist;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.2;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks";
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${appId}.live;
\t\t\t\tPRODUCT_NAME = InterkomLive;
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = ${name};
\t\t};\n`;
  section('XCBuildConfiguration', cfg(ID(12), 'Debug') + cfg(ID(13), 'Release'));
  section('XCConfigurationList', `\t\t${ID(11)} /* Build configuration list for PBXNativeTarget "InterkomLive" */ = {isa = XCConfigurationList; buildConfigurations = (${ID(12)} /* Debug */, ${ID(13)} /* Release */, ); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };\n`);
  // cel aplikacji: osadź rozszerzenie i zbuduj je wcześniej
  put(new RegExp(`${APP} /\\* App \\*/ = \\{\\s*isa = PBXNativeTarget;[\\s\\S]*?buildPhases = \\([\\s\\S]*?Resources \\*/,\\n`), `\t\t\t\t${ID(7)} /* Embed Foundation Extensions */,\n`, 'fazy budowania');
  put(new RegExp(`${APP} /\\* App \\*/ = \\{\\s*isa = PBXNativeTarget;[\\s\\S]*?dependencies = \\(\\n`), `\t\t\t\t${ID(9)} /* PBXTargetDependency */,\n`, 'zależności');
  put(new RegExp(`targets = \\(\\s*${APP} /\\* App \\*/,\\n`), `\t\t\t\t${ID(10)} /* InterkomLive */,\n`, 'lista celów');
  console.log('Dodano kartę na ekran blokady (InterkomLive) do projektu Xcode');
}

// zespół (podpisywanie) i Bundle ID jak w aplikacji – zespół ustawia właściciel w Xcode, nie ma go w repozytorium
const block = (id) => new RegExp(`(${id} /\\* (?:Debug|Release) \\*/ = \\{\\s*isa = XCBuildConfiguration;[\\s\\S]*?buildSettings = \\{\\n)([\\s\\S]*?)(\\n\\t\\t\\t\\};)`);
const team = s.match(new RegExp(`PRODUCT_BUNDLE_IDENTIFIER = ${appId.replace(/\./g, '\\.')};`)) ? s.match(/buildSettings = \{(?:(?!\n\t\t\t\};)[\s\S])*?PRODUCT_BUNDLE_IDENTIFIER = (?!\S+\.live;)[^;]+;/g)?.map((b) => b.match(/DEVELOPMENT_TEAM = ([^;]+);/)?.[1]).find(Boolean) : null;
const base = appId.replace(/\.live$/, '');
for (const id of [ID(12), ID(13)]) {
  if (!block(id).test(s)) throw new Error('nie znaleziono ustawień InterkomLive');
  s = s.replace(block(id), (_, a, body, z) => {
    body = body.replace(/\n?\t*DEVELOPMENT_TEAM = [^;]+;/g, '').replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/, `PRODUCT_BUNDLE_IDENTIFIER = ${base}.live;`);
    return a + body + (team ? `\n\t\t\t\tDEVELOPMENT_TEAM = ${team};` : '') + z;
  });
}
fs.writeFileSync(file, s);
console.log(`InterkomLive: ${base}.live${team ? '' : ' (zespół ustaw w Xcode: App i InterkomLive → Signing & Capabilities)'}`);
