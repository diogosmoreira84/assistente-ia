"""Builds and signs the Assistente IA Android app without Gradle.

Needs a JDK (javac, keytool), Android SDK build-tools (aapt, d8, zipalign, apksigner), the API 19 platform jar and
ZXing core 3.3.3 (https://repo1.maven.org/maven2/com/google/zxing/core/3.3.3/core-3.3.3.jar).
Assistente IA by Diogo Moreira. MIT License.
"""
import argparse
import shutil
import subprocess
import zipfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parent


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--android-jar", required=True, type=Path, help="platforms/android-19/android.jar")
    parser.add_argument("--build-tools", required=True, type=Path, help="directory with aapt, d8, zipalign and apksigner")
    parser.add_argument("--zxing", required=True, type=Path, help="zxing core-3.3.3.jar")
    parser.add_argument("--keystore", required=True, type=Path, help="signing keystore (.p12 or .jks)")
    parser.add_argument("--alias", default="dashboard", help="key alias in the keystore")
    parser.add_argument("--ks-pass-file", required=True, type=Path, help="file holding the keystore password")
    parser.add_argument("--output", type=Path, default=SOURCE / "build")
    args = parser.parse_args()

    tools = args.build_tools.resolve()
    for name in ("aapt", "d8", "zipalign", "apksigner"):
        if not (tools / name).exists() and not (tools / (name + ".bat")).exists() and not (tools / (name + ".exe")).exists():
            parser.error(f"{name} not found in {tools}")
    if not shutil.which("javac"):
        parser.error("javac not found: install a JDK (17 or newer)")

    out = args.output.resolve()
    shutil.rmtree(out, ignore_errors=True)
    classes, dex = out / "classes", out / "dex"
    classes.mkdir(parents=True)
    dex.mkdir()
    jar = args.android_jar.resolve()

    run(tools / "aapt", "package", "-f", "-M", SOURCE / "AndroidManifest.xml", "-S", SOURCE / "res", "-A", SOURCE / "assets",
        "-I", jar, "-F", out / "unsigned.apk")
    run("javac", "-encoding", "UTF-8", "-source", "8", "-target", "8", "-bootclasspath", jar, "-classpath", args.zxing,
        "-d", classes, *sorted((SOURCE / "src").rglob("*.java")))
    run(tools / "d8", "--release", "--min-api", "19", "--lib", jar, "--output", dex, args.zxing, *sorted(classes.rglob("*.class")))
    with zipfile.ZipFile(out / "unsigned.apk", "a") as apk:
        apk.write(dex / "classes.dex", "classes.dex")
    run(tools / "zipalign", "-f", "4", out / "unsigned.apk", out / "aligned.apk")
    run(tools / "apksigner", "sign", "--ks", args.keystore.resolve(), "--ks-key-alias", args.alias,
        "--ks-pass", "file:" + str(args.ks_pass_file.resolve()), "--min-sdk-version", "19",
        "--v1-signing-enabled", "true", "--v2-signing-enabled", "true", "--out", out / "AssistenteIA-Android.apk", out / "aligned.apk")
    run(tools / "apksigner", "verify", "--min-sdk-version", "19", out / "AssistenteIA-Android.apk")
    print("Built", out / "AssistenteIA-Android.apk")


if __name__ == "__main__":
    main()
