# Generated from packaging/pushpilot.rb.in by the release workflow. Do not edit by hand.
class Pushpilot < Formula
  desc "Approved Playwright coverage for outgoing Git changes"
  homepage "https://github.com/Raj-Pratik/e2e-ai"
  version "1.3.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.3.0/pushpilot-1.3.0-darwin-arm64.tar.gz"
      sha256 "fe1004f0772e52de9a230416538a5a76c9a864914cc8f3016afcffd9b55af8d9"
    else
      url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.3.0/pushpilot-1.3.0-darwin-x64.tar.gz"
      sha256 "bc967f2e37569cb6e6c288a95167d5f2830b842cdcb2fe179f8aded62bffff2b"
    end
  end
  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.3.0/pushpilot-1.3.0-linux-arm64.tar.gz"
      sha256 "9fd0ee65ff9a10126ec1190e62fb25ec6f54c105644f73bee32015e3a621db35"
    else
      url "https://github.com/Raj-Pratik/e2e-ai/releases/download/v1.3.0/pushpilot-1.3.0-linux-x64.tar.gz"
      sha256 "363a29b44a44911006d0cb23dd74780440e84dacb4e44005d9256f2be99bab4a"
    end
  end
  def install
    libexec.install Dir["*"]
    (bin/"pushpilot").write <<~EOS
      #!/bin/sh
      exec "#{libexec}/pushpilot" "$@"
    EOS
  end
  test do
    assert_equal version.to_s, shell_output("#{bin}/pushpilot --version").strip
  end
end
