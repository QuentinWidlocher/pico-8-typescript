#!/usr/bin/env node

import * as child_process from "child_process";
import * as fse from "fs-extra";
import * as path from "path";
import * as yesno from "yesno";
import * as commander from "commander";
import * as chokidar from "chokidar";
import * as uglifyJS from "uglify-js";

// Program constants (hardcoded locations)
const workDir = "p8workspace";
const fullWorkDir = path.join(__dirname, "..", workDir);

// This defines the default location for pico-8 on various platforms
// If none of these are found the pico-8 entry in tspico8.json is used
const pico8PathMap = {
  win32: `"C:\\Program Files (x86)\\PICO-8\\pico8.exe"`, // eslint-disable-line quotes
  darwin: "/Applications/PICO-8.app/Contents/MacOS/pico8",
  linux: "~/pico-8/pico8",
};

// Invocations
const program = new commander.Command();
program
  .command("init")
  .description(
    `Copy the required files inside ${workDir} directory. If a file already exists, it will be skipped.`,
  )
  .action(init);

program
  .command("run")
  .description(" Build, watch, and launch your PICO-8 game")
  .action(build);

program.parse();

// Location of the TypeScript config file
function getTSConfig(): any {
  const tsConfigPath = path.join(fullWorkDir, "tsconfig.json");
  return JSON.parse(fse.readFileSync(tsConfigPath, "utf8"));
}

// Location of the transpiler config file
function getTSPicoConfig(): any {
  const tsConfigPath = path.join(fullWorkDir, "tspico8.json");
  return JSON.parse(fse.readFileSync(tsConfigPath, "utf8"));
}

// Location of the output generated by TypeScript (tsc)
function getOutfile(): string {
  const tsConfig = getTSConfig();
  return path.join(fullWorkDir, tsConfig.compilerOptions.outFile);
}

// Location of the output file after compression (uglified)
function getOutfileCompressed(): string {
  const picoConfig = getTSPicoConfig();
  return path.join(fullWorkDir, picoConfig.compression.compressedFile);
}

/**
 * Initialization code
 * Copy required files to working dir
 */
function init(): void {
  const copyDir = path.join(__dirname, "..", "tocopy");
  const buildDir = path.join(fullWorkDir, "build");
  const compileDir = path.join(buildDir, "compiled.js");

  // Create the destination directory if it doesn't exist
  fse.existsSync(fullWorkDir) || fse.mkdirSync(fullWorkDir);
  // Create the build directory if it doesn't exist
  fse.existsSync(buildDir) || fse.mkdirSync(buildDir);
  // Create an empty compiled.js file if it doesn't exist
  fse.writeFile(compileDir, "", { flag: 'wx' }, function (err) {
    if (err) throw err;
  });

  console.log(
    `The following files will be added to the ${fullWorkDir} directory:`,
  );

  // Fetch all files to copy
  fse.readdirSync(copyDir).forEach((file) => {
    console.log(file);
  });

  yesno({ question: "Proceed to copy? (y/n)" }).then((ok) => {
    if (!ok) {
      console.log("Stopping installation.");
      process.exit(0);
    }

    // Copy files to the working directory
    fse.readdirSync(copyDir).forEach((file: string) => {
      const from = path.join(copyDir, file);
      const to = path.join(fullWorkDir, file);
      fse.copySync(from, to, {
        filter: () => {
          // Avoid copying files that already exist
          if (fse.existsSync(to)) {
            console.log(`/!\\ ${file} already exists in directory, skipping.`);
            return false;
          }
          return true;
        },
      });
    });

    console.log(
      `\nCopying complete. Edit the ${workDir}/tspico8.json, then type "bin/tspico8 run."`,
    );
    process.exit(0);
  });
}

/**
 * Return a string that points to the pico-8 executable
 * or an empty string if it cannot be found.
 */
function picoPath(): string {
  const config = getTSPicoConfig();
  const cPico: {
    executable: string;
  } = config["pico8"];

  let picoPath = "";

  // attempt to use default locations for pico-8, and cascade to config if not found
  if (fse.existsSync(pico8PathMap[process.platform])) {
    picoPath = pico8PathMap[process.platform];
  } else if (fse.existsSync(cPico.executable)) {
    picoPath = cPico.executable;
  }
  return picoPath;
}

/**
 * Launch pico-8 with the game file
 */
function launchPico(
  picoPath: string,
  cartridgePath: string,
): child_process.ChildProcess {
  console.log(`${picoPath} -root_path ${fullWorkDir} -run ${path.resolve(cartridgePath)}`);

  let picoProcess = child_process.spawn(
    picoPath,
    [
      "-root_path", fullWorkDir,
      "-run", `"${path.resolve(cartridgePath)}"`,
    ],
    {
      shell: true,
    },
  );

  picoProcess.on("close", (code) => {
    picoProcess = null;
    code && console.log(`Pico-8 process exited with code ${code}.`); // eslint-disable-line no-console
  });
  return picoProcess;
}

/*
 * Compile the TypeScript code
 */
function compileTS(fullDestDir: string): void {
  child_process.execSync("tsc", { encoding: "utf-8", cwd: fullDestDir });
}

/*
 * Run the generated JavaScript (from tsc)
 * through uglify to produce the compressed source code
 */
function compressGameFile(): void {
  let config = getTSPicoConfig();
  let buildStr = fse.readFileSync(getOutfile(), "utf8");
  // Explicit strict mode breaks the global TIC scope
  buildStr = buildStr.replace('"use strict";', "");

  const cCompress: {
    compressedFile: string;
    indentLevel: number;
    compress: boolean;
    mangle: boolean;
  } = config["compression"];

  const result = uglifyJS.minify(buildStr, {
    compress: cCompress.compress ? { ...config["compressOptions"] } : false,
    mangle: cCompress.mangle ? { ...config["mangleOptions"] } : false,
    output: {
      semicolons: false, // Only works if `mangle` or `compress` are set to false
      beautify: !(cCompress.mangle || cCompress.compress),
      indent_level: cCompress.indentLevel,
      // Always keep the significant comments: https://github.com/nesbox/TIC-80/wiki/The-Code
      comments:
        cCompress.compress || cCompress.mangle
          ? RegExp(/title|author|desc|script|input|saveid/)
          : true,
    },
  });

  if (result.code.length < 10) {
    console.log("Empty code.");
    console.log(buildStr);
  }
  fse.writeFileSync(getOutfileCompressed(), result.code);
}

function compileCart(jsFile: string, newGameFile: string, spriteFile: string, refGameFile: string): void {
  console.log(
    `jspicl-cli --input ${jsFile} --output ${newGameFile} --spritesheetImagePath ${spriteFile} --cartridgePath ${refGameFile}`,
  );

  child_process.spawnSync(
    "jspicl-cli",
    [
      `--input ${jsFile}`,
      `--output ${newGameFile}`,
      `--spritesheetImagePath ${spriteFile}`,
      `--cartridgePath ${refGameFile}`,
    ],
    { shell: true },
  );
}

/*
 * Assemble the assets (code and spritesheet) into a .p8 file
*/
function buildGameFile() {
  const outFileCompressed = getOutfileCompressed();
  const gameFile = path.join(fullWorkDir, "game.p8");
  const spriteFile = path.join(fullWorkDir, "spritesheet.png");
  compileCart(outFileCompressed, gameFile, spriteFile, gameFile);
}

/**
 * Compile, compress, run
 */
function build(): void {
  const pPath = picoPath();
  const gameFile = path.join(fullWorkDir, "game.p8");
  const toWatch = [path.join(fullWorkDir, "**/*.ts"), path.join(fullWorkDir, "spritesheet.png")];
  let proc: child_process.ChildProcess = null;

  function buildAll() {
      console.log("Compiling TypeScript to JavaScript.");
      compileTS(fullWorkDir);
      console.log("Compressing JavaScript.");
      compressGameFile();
      console.log("Building game file.");
      buildGameFile();
      if (pPath.length > 0) {
        // Kill the existing pico-8 process if it is running
        if (proc) {
          console.log("Killing existing pico-8 process.");
          proc.kill();
        }
        console.log("Launching pico-8.");
        proc = launchPico(pPath, gameFile);
      }
  }

  // Do the initial build and launch pico-8
  buildAll();

  // watch for changes and update accordingly
  // don't use tsc --watch because we want more granular control
  // over the steps of the build process
  chokidar.watch(toWatch).on("change", (path, stats) => {
    try {
        buildAll();
      } catch (e) {
        console.error(e);
      }
  });
}