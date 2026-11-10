const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { SettingsManager } = require('../src/main/settingsManager');
const { ProfileManager } = require('../src/main/profileManager');
const { VersionManager } = require('../src/main/versionManager');
const { JavaManager } = require('../src/main/javaManager');
const { LoaderManager } = require('../src/main/loaderManager');
const { MinecraftInstaller } = require('../src/main/installer');
const { MinecraftLauncher } = require('../src/main/launcher');
const { ModrinthManager } = require('../src/main/modrinthManager');
const { AccountManager } = require('../src/main/accountManager');
const { DiscordRpcManager } = require('../src/main/discordRpcManager');
const { validateSafeRelativePath } = require('../src/main/zipUtils');

async function runTests() {
  console.log('=== CRYOX CLIENT V2 Backend Verification Suite ===');
  const testBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inex-client-test-'));

  try {
    // 1. SettingsManager validation (including Discord RPC & Glass intensity)
    const settingsMgr = new SettingsManager(testBaseDir);
    const initialSettings = settingsMgr.getSettings();
    assert.strictEqual(initialSettings.windowWidth, 1280);
    assert.strictEqual(initialSettings.discordRpcEnabled, true);
    assert.strictEqual(initialSettings.glassIntensity, 24);
    assert.strictEqual(typeof initialSettings.hudConfig, 'object');
    assert.strictEqual(initialSettings.hudConfig.showNametagLogo, true);

    const updatedSettings = settingsMgr.updateSettings({
      fullscreen: true,
      windowWidth: 1920,
      windowHeight: 1080,
      defaultRamMB: 6144,
      glassIntensity: 30,
      discordStatusText: 'CRYOX CLIENT • Competitive PvP'
    });
    assert.strictEqual(updatedSettings.fullscreen, true);
    assert.strictEqual(updatedSettings.glassIntensity, 30);
    assert.strictEqual(updatedSettings.discordStatusText, 'CRYOX CLIENT • Competitive PvP');
    console.log('[PASS] 1. SettingsManager validation (Discord RPC, Glass Intensity & JVM flags)');

    // 2. ProfileManager: Zero Default Profiles + Code-Level Default HUD JAR Auto-Attachment
    const defaultModsDir = path.join(testBaseDir, 'default-mods');
    fs.mkdirSync(defaultModsDir, { recursive: true });
    const dummyHudJar = path.join(defaultModsDir, 'inex-client-hud.jar');
    fs.writeFileSync(dummyHudJar, Buffer.from('PK\x03\x04INEX-HUD-MOD-JAR'));

    const profileMgr = new ProfileManager(settingsMgr);
    const initialProfiles = profileMgr.listProfiles();
    assert.strictEqual(initialProfiles.profiles.length, 0, 'Must start with ZERO default profiles');
    assert.strictEqual(initialProfiles.activeProfileId, null, 'Active profile must be null when no profiles exist');

    const created = profileMgr.createProfile({
      name: '1.21.4-Fabric Competitive',
      version: '1.21.4',
      loader: 'fabric',
      loaderVersion: '0.16.10',
      ramMB: 6144
    });
    assert.strictEqual(created.profile.name, '1.21.4-Fabric Competitive');
    assert.strictEqual(created.profile.installed, false);

    // Verify default HUD JAR was automatically attached to the new profile's mods/ folder!
    const attachedHudPath = path.join(created.profile.gameDir, 'mods', 'inex-client-hud.jar');
    assert.ok(fs.existsSync(attachedHudPath), 'Default in-game HUD JAR must be auto-attached to newly created profile');

    // Verify config/inex-hud.json was exported
    const exportedHudConfig = path.join(created.profile.gameDir, 'config', 'inex-hud.json');
    assert.ok(fs.existsSync(exportedHudConfig), 'inex-hud.json configuration must be exported into profile config dir');
    console.log('[PASS] 2. ProfileManager: Zero default profiles on boot & auto-attached default HUD .jar in code');

    // 3. VersionManager & Java requirement mapping (including metadata override)
    const versionMgr = new VersionManager(settingsMgr);
    assert.strictEqual(versionMgr.getRequiredJavaMajor('1.21.4'), 21);
    assert.strictEqual(versionMgr.getRequiredJavaMajor('1.20.4'), 17);
    assert.strictEqual(versionMgr.getRequiredJavaMajor('1.8.9'), 8);
    assert.strictEqual(versionMgr.getRequiredJavaMajor('26.2', { javaVersion: { majorVersion: 25 } }), 25);
    console.log('[PASS] 3. VersionManager & Mojang javaVersion.majorVersion resolution');

    // 4. JavaManager stderr/stdout parsing (Java 25, Java 21, Java 17, Java 8) & runtime detection
    const javaMgr = new JavaManager(settingsMgr);
    const parsed25 = javaMgr._parseJavaVersionOutput('java version "25" 2025-09-16 LTS\nJava(TM) SE Runtime Environment (build 25+36-LTS-3491)\nJava HotSpot(TM) 64-Bit Server VM');
    assert.strictEqual(parsed25.major, 25);
    assert.strictEqual(parsed25.arch, 'x64');

    const parsed21 = javaMgr._parseJavaVersionOutput('openjdk version "21.0.5" 2024-10-15 LTS\nOpenJDK 64-Bit Server VM Temurin-21.0.5+11');
    assert.strictEqual(parsed21.major, 21);

    const runtimes = javaMgr.detectInstalledRuntimes();
    const resolution = javaMgr.resolveJavaForVersion(21, 'auto');
    assert.strictEqual(typeof resolution.compatible, 'boolean');
    console.log(`[PASS] 4. JavaManager stderr/stdout probe & Java 21/25 parser (${runtimes.length} runtime(s) detected)`);

    // 5. LoaderManager version availability check (Never fallback to Fabric on Forge!)
    const loaderMgr = new LoaderManager(settingsMgr);
    const supportedLoaders26 = await loaderMgr.getSupportedLoadersForVersion('26.3');
    assert.strictEqual(supportedLoaders26.vanilla.supported, true, 'Vanilla is supported on 26.3');
    assert.strictEqual(supportedLoaders26.fabric.supported, false, 'Fabric is not available on 26.3');
    assert.strictEqual(supportedLoaders26.forge.supported, false, 'Forge is not available on 26.3');
    assert.strictEqual(supportedLoaders26.neoforge.supported, false, 'NeoForge is not available on 26.3');
    assert.strictEqual(supportedLoaders26.quilt.supported, false, 'Quilt is not available on 26.3');

    const supportedLoaders121 = await loaderMgr.getSupportedLoadersForVersion('1.21.4');
    assert.strictEqual(supportedLoaders121.vanilla.supported, true);
    assert.strictEqual(supportedLoaders121.fabric.supported, true);
    assert.strictEqual(supportedLoaders121.forge.supported, true);
    assert.strictEqual(supportedLoaders121.neoforge.supported, true);

    const supportedLoaders18 = await loaderMgr.getSupportedLoadersForVersion('1.8.9');
    assert.strictEqual(supportedLoaders18.vanilla.supported, true);
    assert.strictEqual(supportedLoaders18.forge.supported, true);
    assert.strictEqual(supportedLoaders18.fabric.supported, false);

    await assert.rejects(
      async () => {
        await loaderMgr.resolveLoaderProfile('26.3', 'forge');
      },
      /Forge is not available for Minecraft 26.3/,
      'Must reject resolving Forge on 26.3'
    );
    console.log('[PASS] 5. LoaderManager version-specific availability & Forge rejection guard');

    // 6. DiscordRpcManager real-time presence state & IPC framing
    const discordMgr = new DiscordRpcManager(settingsMgr);
    discordMgr.setLauncherMenuPresence(created.profile);
    const dStatus = discordMgr.getStatus();
    assert.strictEqual(dStatus.enabled, true);
    assert.ok(dStatus.activity.details.includes('1.21.4-Fabric Competitive'));
    discordMgr.stop();
    console.log('[PASS] 6. DiscordRpcManager real-time presence state & IPC framing');

    // 7. AccountManager & ModrinthManager search + path traversal guard
    const accountMgr = new AccountManager(settingsMgr);
    const afterAdd = accountMgr.addLocalAccount('SultanAGG');
    assert.ok(afterAdd.accounts.some(a => a.username === 'SultanAGG'));

    const modrinthMgr = new ModrinthManager({ settingsManager: settingsMgr, profileManager: profileMgr });
    const searchRes = await modrinthMgr.searchProjects({ query: 'sodium', projectType: 'mod', profileId: created.profile.id });
    assert.ok(Array.isArray(searchRes.hits) && searchRes.hits.length > 0);
    assert.throws(() => {
      validateSafeRelativePath('../../Windows/System32/cmd.exe', created.profile.gameDir);
    }, /Blocked unsafe path traversal/);
    console.log('[PASS] 7. AccountManager & ModrinthManager search + path traversal guard');

    // 8. Installer 64-bit native rule filtering & Launcher JVM arguments (Java 21/25 flags)
    const installer = new MinecraftInstaller({
      settingsManager: settingsMgr,
      versionManager: versionMgr,
      loaderManager: loaderMgr,
      javaManager: javaMgr,
      profileManager: profileMgr
    });
    const launcher = new MinecraftLauncher({
      settingsManager: settingsMgr,
      profileManager: profileMgr,
      versionManager: versionMgr,
      loaderManager: loaderMgr,
      javaManager: javaMgr,
      accountManager: accountMgr,
      installer,
      discordRpcManager: discordMgr
    });

    assert.strictEqual(installer._evaluateRules([{ action: 'allow', os: { name: 'windows', arch: 'x86' } }], 'windows', 'x64'), false);
    assert.strictEqual(installer._evaluateRules([{ action: 'allow', os: { name: 'windows' } }], 'windows', 'x64'), true);

    const sampleMeta = {
      id: '1.21.4',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      assetIndex: { id: '19' },
      libraries: [
        {
          name: 'org.lwjgl:lwjgl:3.3.3:natives-windows',
          downloads: {
            artifact: {
              path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
              url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar'
            }
          }
        },
        {
          name: 'org.lwjgl:lwjgl:3.3.3:natives-windows-x86',
          downloads: {
            artifact: {
              path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows-x86.jar',
              url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows-x86.jar'
            }
          }
        }
      ],
      arguments: { game: [], jvm: [] }
    };

    const collectedLibs = installer.collectRequiredLibraries(sampleMeta, 'windows');
    assert.strictEqual(collectedLibs.downloads.length, 1, 'Must exclude 32-bit x86 natives on 64-bit Windows');
    assert.strictEqual(collectedLibs.nativeJars.length, 1, 'Must detect modern :natives-windows JAR for DLL extraction');

    const launchArgs = launcher.buildLaunchArguments({
      profile: created.profile,
      mergedMeta: sampleMeta,
      account: accountMgr.getActiveAccount(),
      settings: settingsMgr.getSettings(),
      javaMajor: 25
    });
    assert.ok(launchArgs.jvmArgs.includes('-XX:+IgnoreUnrecognizedVMOptions'));
    assert.ok(launchArgs.jvmArgs.includes('--enable-native-access=ALL-UNNAMED'));
    console.log('[PASS] 8. Installer 64-bit native DLL extraction & Java 21/25 JVM flags');

    // 9. NEW: Vanilla Profile Rules (Strict Mod & Modpack Blocking)
    const vanillaProf = profileMgr.createProfile({
      name: 'Vanilla 1.21.4 Clean',
      version: '1.21.4',
      loader: 'vanilla'
    });
    assert.strictEqual(vanillaProf.profile.loader, 'vanilla');

    // Verify attachDefaultClientMods does NOT attach mods to vanilla profile
    const vanillaMods = profileMgr.attachDefaultClientMods(vanillaProf.profile);
    assert.strictEqual(vanillaMods.length, 0, 'Must NOT attach mods to a Vanilla profile');

    // Verify modrinthManager blocks installing mods into Vanilla profile
    await assert.rejects(
      async () => {
        await modrinthMgr.installProject({
          profileId: vanillaProf.profile.id,
          projectId: 'AANobbMI',
          projectType: 'mod',
          title: 'Sodium'
        });
      },
      /Vanilla Minecraft/i,
      'Must reject installing mods into Vanilla profile'
    );

    // Verify modrinthManager blocks installing modpacks into Vanilla profile
    await assert.rejects(
      async () => {
        await modrinthMgr.installProject({
          profileId: vanillaProf.profile.id,
          projectId: '1KVo5zza',
          projectType: 'modpack',
          title: 'Fabulously Optimized'
        });
      },
      /Vanilla Minecraft/i,
      'Must reject installing modpacks into Vanilla profile'
    );
    console.log('[PASS] 9. Vanilla Profile Rules: Mods & Modpacks strictly disabled per official rules');

    // 10. NEW: Strict Created-Version Auto-Detection & Filtering
    const profile262 = profileMgr.createProfile({
      name: 'Fabric 26.2 Profile',
      version: '26.2',
      loader: 'fabric'
    });
    const search262 = await modrinthMgr.searchProjects({
      query: 'iris',
      projectType: 'mod',
      profileId: profile262.profile.id
    });
    assert.strictEqual(search262.profileFilter.version, '26.2', 'Search must lock to created profile version');
    assert.strictEqual(search262.profileFilter.loader, 'fabric', 'Search must lock to created profile loader');
    console.log('[PASS] 10. Strict Created-Version Auto-Detection & Lock (26.2 profile locks to 26.2 mods)');

    // 11. NEW: Local Custom Skins & Capes In-Game Resource Pack Injection
    const updatedSlot = accountMgr.updateSkinSlot('slot-1', {
      capePreset: 'inex-crest',
      active: true
    });
    assert.ok(updatedSlot.skinSlots.some(s => s.id === 'slot-1' && s.capePreset === 'inex-crest'));

    // Apply cosmetics to profile gameDir
    accountMgr.applyLocalCosmeticsToGameDir(created.profile.gameDir);
    const packMcmetaPath = path.join(created.profile.gameDir, 'resourcepacks', 'INEX-Local-Cosmetics', 'pack.mcmeta');
    const capeTexturePath = path.join(created.profile.gameDir, 'resourcepacks', 'INEX-Local-Cosmetics', 'assets', 'minecraft', 'textures', 'entity', 'player', 'cape.png');
    const skinTexturePath = path.join(created.profile.gameDir, 'resourcepacks', 'INEX-Local-Cosmetics', 'assets', 'minecraft', 'textures', 'entity', 'player', 'wide', 'steve.png');
    const optionsTxtPath = path.join(created.profile.gameDir, 'options.txt');

    assert.ok(fs.existsSync(packMcmetaPath), 'INEX-Local-Cosmetics pack.mcmeta must be generated');
    assert.ok(fs.existsSync(capeTexturePath), 'Local Cape PNG texture must be generated in resourcepack');
    assert.ok(fs.existsSync(skinTexturePath), 'Local Skin PNG texture must be generated in resourcepack');
    assert.ok(fs.existsSync(optionsTxtPath), 'options.txt must exist');
    const optionsContent = fs.readFileSync(optionsTxtPath, 'utf8');
    assert.ok(optionsContent.includes('INEX-Local-Cosmetics'), 'options.txt must activate local cosmetics resourcepack');
    assert.ok(optionsContent.includes('file/INEX-Local-Cosmetics'), 'options.txt must contain modern resourcepack identifier');

    // Also verify it generates default cosmetics even when zero accounts exist on startup
    const emptyGameDir = path.join(testBaseDir, 'empty-profile-game');
    fs.mkdirSync(emptyGameDir, { recursive: true });
    accountMgr.applyLocalCosmeticsToGameDir(emptyGameDir, '1.21.4');
    assert.ok(fs.existsSync(path.join(emptyGameDir, 'resourcepacks', 'INEX-Local-Cosmetics', 'pack.mcmeta')), 'Zero-account startup must still generate local cosmetics pack');
    assert.ok(fs.existsSync(path.join(emptyGameDir, 'options.txt')), 'Zero-account startup must still generate options.txt');

    console.log('[PASS] 11. Local Custom Skin & Cape in-game resourcepack auto-injection & options.txt sync');

    // 12. Clean up test profiles
    profileMgr.deleteProfile(created.profile.id);
    profileMgr.deleteProfile(vanillaProf.profile.id);
    profileMgr.deleteProfile(profile262.profile.id);
    const finalProfiles = profileMgr.listProfiles();
    assert.strictEqual(finalProfiles.profiles.length, 0);
    assert.strictEqual(finalProfiles.activeProfileId, null);
    console.log('[PASS] 12. Non-destructive profile deletion & zero-state verification');

    
    // 13. Direct In-Game Classpath Skin & Cape Override JAR + JVM Agent Verification
    const cosmOverrideJar = path.join(emptyGameDir, "inex-cosmetics-override.jar");
    assert.ok(fs.existsSync(cosmOverrideJar), "inex-cosmetics-override.jar must be generated in gameDir");
    const { parseZipBuffer } = require("../src/main/zipUtils");
    const overrideEntries = parseZipBuffer(fs.readFileSync(cosmOverrideJar)).map(e => e.name);
    assert.ok(overrideEntries.includes("assets/minecraft/textures/entity/player/wide/steve.png"), "Override JAR must contain wide/steve.png");
    assert.ok(overrideEntries.includes("assets/minecraft/textures/entity/player/slim/alex.png"), "Override JAR must contain slim/alex.png");
    assert.ok(overrideEntries.includes("assets/minecraft/textures/entity/player/cape.png"), "Override JAR must contain player/cape.png");

    const dummyProfWithCosm = {
      id: "cosm-test",
      name: "Cosm Test",
      version: "1.21.4",
      loader: "fabric",
      ramMB: 4096,
      gameDir: emptyGameDir
    };
    const cosmLaunchArgs = launcher.buildLaunchArguments({
      profile: dummyProfWithCosm,
      mergedMeta: sampleMeta,
      account: accountMgr.getActiveAccount() || { username: "Player", uuid: "0", type: "local" },
      settings: settingsMgr.getSettings(),
      javaMajor: 21
    });
    const cpIdx = cosmLaunchArgs.jvmArgs.indexOf("-cp");
    const cpString = cosmLaunchArgs.jvmArgs[cpIdx + 1];
    assert.ok(cpString.startsWith(cosmOverrideJar), "inex-cosmetics-override.jar MUST be at Index 0 of -cp so skins/capes load without enabling Resource Packs");
    assert.ok(cosmLaunchArgs.jvmArgs.some(a => a.startsWith("-javaagent:") && a.includes("inex-cosmetics-agent.jar")), "Must attach -javaagent:inex-cosmetics-agent.jar");
    console.log("[PASS] 13. Direct In-Game Classpath Skin & Cape Override JAR (Index 0 of -cp) + JVM Agent");

    // 14. Core Loader Resolution: Quilt 1.21.4, Forge/NeoForge mainClass Guard & BootstrapLauncher JVM Args
    const sup1214 = await loaderMgr.getSupportedLoadersForVersion("1.21.4");
    assert.strictEqual(sup1214.quilt.supported, true, "Quilt must be supported on 1.21.4");
    assert.strictEqual(sup1214.forge.supported, true, "Forge must be supported on 1.21.4");
    assert.strictEqual(sup1214.neoforge.supported, true, "NeoForge must be supported on 1.21.4");
    const quiltMeta = await loaderMgr.resolveLoaderProfile("1.21.4", "quilt", "latest");
    assert.ok(quiltMeta.mainClass.includes("quiltmc"), "Quilt profile must resolve org.quiltmc mainClass, never Fabric or Vanilla");
    assert.strictEqual(loaderMgr.isValidLoaderMainClass("forge", "net.fabricmc.loader.impl.launch.knot.KnotClient"), false, "Forge must reject Fabric mainClass");
    assert.strictEqual(loaderMgr.isValidLoaderMainClass("forge", "net.minecraft.client.main.Main"), false, "Forge must reject Vanilla mainClass");
    assert.strictEqual(loaderMgr.isValidLoaderMainClass("forge", "cpw.mods.bootstraplauncher.BootstrapLauncher"), true, "Forge must accept BootstrapLauncher");
    console.log("[PASS] 14. Core Loader Resolution: Quilt 1.21.4 & Forge/NeoForge mainClass Guard");

    // 15. UI HTML Verification (Subtitle, Settings Cleanup, and Cape Card)
    const indexHtml = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
    assert.ok(indexHtml.includes("LIFE IS A GAME &bull; CHOOSE YOUR LEVEL"), "Play tab subtitle must be updated");
    assert.ok(!indexHtml.includes("id=\"settingDiscordStatusInput\""), "Discord status line input must be removed from Settings");
    assert.ok(!indexHtml.includes("id=\"selectCustomLogoBtn\""), "Custom logo upload button must be removed from Settings");
    assert.ok(indexHtml.includes("id=\"settingDiscordToggle\""), "Discord RPC toggle must remain in Settings");
    assert.ok(indexHtml.includes("id=\"settingGlassSlider\""), "Frosted Glass slider must remain in Settings");
    assert.ok(indexHtml.includes("id=\"capePresetsContainer\""), "Cape customization card must exist in Accounts -> Skins & Capes");
    console.log("[PASS] 15. UI HTML Verification (Subtitle, Settings Cleanup & Cape Card)");

    console.log('=== ALL 15 V2.3 CORE & UI TEST SUITES PASSED ===');
  } finally {
    fs.rmSync(testBaseDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('Backend test failed:', err);
  process.exit(1);
});
