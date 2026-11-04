#!/bin/bash
# Configures the generated Capacitor iOS project for Toplix Pro.
# Run from the repository root after `npx cap add ios`.
set -euo pipefail
APP=mobile/ios/App

# 1) Swift sources
cp mobile/native/ios/MainViewController.swift mobile/native/ios/ToplixNativePlugin.swift "$APP/App/"

# 2) Use our view controller so the native helper is registered
SB="$APP/App/Base.lproj/Main.storyboard"
sed -i '' -E 's/customClass="CAPBridgeViewController" customModule="Capacitor"/customClass="MainViewController" customModule="App" customModuleProvider="target"/' "$SB"
grep -q MainViewController "$SB" || { echo "storyboard patch failed"; exit 1; }

# 3) Add the sources to the app target
cd "$APP"
ruby -e '
require "xcodeproj"
proj = Xcodeproj::Project.open("App.xcodeproj")
target = proj.targets.find { |t| t.name == "App" }
group = proj.main_group.find_subpath("App", true)
["MainViewController.swift", "ToplixNativePlugin.swift"].each do |f|
  ref = group.new_file(f)
  target.add_file_references([ref])
end
proj.save
'

# 4) Info.plist: toplex:// link, app detection, local-network chat servers
PL=App/Info.plist
PB=/usr/libexec/PlistBuddy
$PB -c "Delete :CFBundleURLTypes" "$PL" 2>/dev/null || true
$PB -c "Add :CFBundleURLTypes array" "$PL"
$PB -c "Add :CFBundleURLTypes:0 dict" "$PL"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLName string com.homekidchud.toplexpro" "$PL"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PL"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string toplex" "$PL"
$PB -c "Delete :LSApplicationQueriesSchemes" "$PL" 2>/dev/null || true
$PB -c "Add :LSApplicationQueriesSchemes array" "$PL"
$PB -c "Add :LSApplicationQueriesSchemes:0 string chatgpt" "$PL"
$PB -c "Add :LSApplicationQueriesSchemes:1 string claude" "$PL"
$PB -c "Delete :NSAppTransportSecurity" "$PL" 2>/dev/null || true
$PB -c "Add :NSAppTransportSecurity dict" "$PL"
$PB -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$PL"
$PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PL"
$PB -c "Delete :NSLocalNetworkUsageDescription" "$PL" 2>/dev/null || true
$PB -c "Add :NSLocalNetworkUsageDescription string Toplix Pro connects to AI servers on your local network (for example Ollama or LM Studio) only when you set one up." "$PL"
$PB -c "Set :CFBundleDisplayName Toplix Pro" "$PL" 2>/dev/null || $PB -c "Add :CFBundleDisplayName string Toplix Pro" "$PL"
echo "iOS project configured"
