Pod::Spec.new do |s|
  s.name = 'LocalMedia'
  s.version = '1.0.0'
  s.summary = 'Backup exclusions for account-owned local photos.'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'MomentLens'
  s.homepage = 'https://github.com/MomentLens/app'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => 'https://github.com/MomentLens/app.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
