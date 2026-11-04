package expo.modules.ipv4first

import java.net.Inet4Address
import java.net.InetAddress
import okhttp3.Dns

// The system's addresses for a host, IPv4 ones first. OkHttp 4, which this app ships, tries a
// host's addresses one at a time in the order it gets them, and waits out each one's connect
// timeout before the next. Android puts IPv6 first whenever the network hands out an IPv6 address.
// So on a Wi-Fi that hands one out but drops every IPv6 packet, each new connection to a host with
// an IPv6 address (R2 has one, the API does not) waited 60 s or more before it tried IPv4: an
// upload stalled 60 to 125 s on 2026-11-04. The IPv6 addresses stay at the end of the list, so a
// network with IPv6 and no IPv4 still connects.
object Ipv4FirstDns : Dns {
  override fun lookup(hostname: String): List<InetAddress> =
    Dns.SYSTEM.lookup(hostname).sortedBy { if (it is Inet4Address) 0 else 1 }
}
