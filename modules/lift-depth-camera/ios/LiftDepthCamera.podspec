Pod::Spec.new do |s|
  s.name           = 'LiftDepthCamera'
  s.version        = '1.0.0'
  s.summary        = 'LiDAR depth capture for meal photos'
  s.description    = 'Native camera capture that pairs the photo with a LiDAR depth map so the nutrition AI gets real-world scale for portion estimation.'
  s.author         = 'LiftAI'
  s.homepage       = 'https://liftaiapp.com'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,swift}'
end
