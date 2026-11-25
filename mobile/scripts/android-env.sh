# Wspólne dla skryptów Android: położenie klucza i JDK 21 (Gradle nie działa z nowszym JDK z Android Studio).
IK_KEYSTORE="${IK_KEYSTORE:-$HOME/.interkom/interkom-release.jks}"
if [ -z "${IK_JAVA_HOME:-}" ]; then
  IK_JAVA_HOME="$(/usr/libexec/java_home -v 21 -F 2>/dev/null || true)"
  [ -n "$IK_JAVA_HOME" ] || IK_JAVA_HOME="$(ls -d "$HOME"/Library/Java/JavaVirtualMachines/*21*/Contents/Home 2>/dev/null | head -1 || true)"
fi
[ -n "$IK_JAVA_HOME" ] && [ -x "$IK_JAVA_HOME/bin/keytool" ] || { echo "Brak JDK 21 – w Android Studio: Settings → Build Tools → Gradle → Gradle JDK → Download JDK → 21."; exit 1; }
export JAVA_HOME="$IK_JAVA_HOME" IK_KEYSTORE
