require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'IkAudio'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'UNLICENSED'
  s.homepage = 'https://example.invalid/interkom'
  s.author = 'Interkom'
  s.source = { :git => 'https://example.invalid/interkom.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'LiveKitClient', '~> 2.19'
  s.swift_version = '5.9'
end
