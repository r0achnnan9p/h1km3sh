import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("hikvision_export.py")
spec = importlib.util.spec_from_file_location("hikvision_export", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HikvisionExportTests(unittest.TestCase):
    def cli_args(self):
        return ["2026-01-01", "12:00", "12:01", "201", "sample",
                "--ip", "192.0.2.10", "--user", "operator",
                "--output-dir", "./clips", "--cache-dir", "./cache", "--work-dir", "./work"]

    def test_cli_requires_explicit_recorder_and_directories(self):
        with self.assertRaises(SystemExit) as result:
            module.parse_args(["2026-01-01", "12:00", "12:01", "201", "sample"])
        self.assertEqual(result.exception.code, 2)

    def test_cli_has_no_personal_jump_or_password_file_defaults(self):
        args = module.parse_args(self.cli_args())
        for field in ("jump", "jump_user", "jump_key", "known_hosts", "password_file"):
            self.assertIsNone(getattr(args, field))
        self.assertEqual(args.ip, "192.0.2.10")

    def test_jump_requires_explicit_credentials_and_host_trust(self):
        with self.assertRaises(SystemExit) as result:
            module.parse_args(self.cli_args() + ["--jump", "jump.example.com"])
        self.assertEqual(result.exception.code, 2)
        args = module.parse_args(self.cli_args() + ["--jump", "jump.example.com", "--jump-user", "operator",
                                 "--jump-key", "./private-key", "--known-hosts", "./known-hosts"])
        self.assertEqual(args.jump_user, "operator")

    def test_no_jump_explicitly_disables_incomplete_tunnel(self):
        args = module.parse_args(self.cli_args() + ["--jump", "jump.example.com", "--no-jump"])
        self.assertTrue(args.no_jump)

    def test_compact_time_uses_wall_clock(self):
        self.assertEqual(module.compact_time("2026-09-09", "20:15"), "20260909T201500Z")
        self.assertEqual(module.iso_time("20260909T220800Z"), "2026-09-09T22:08:00Z")

    def test_search_xml_has_hikvision_track_list_and_single_root(self):
        xml = module.build_search_xml(
            "search-id", "201", "2026-09-09T20:15:00Z", "2026-09-09T22:08:00Z", 40, 0
        )
        self.assertEqual(xml.count("<CMSearchDescription>"), 1)
        self.assertIn("<trackList><trackID>201</trackID></trackList>", xml)
        self.assertIn("<searchResultPostion>0</searchResultPostion>", xml)
        self.assertNotIn("&", xml)

    def test_download_xml_escapes_ampersands(self):
        xml = module.build_download_xml("rtsp://dvr/Streaming/tracks/201/?starttime=a&size=42")
        self.assertIn("&amp;size=42", xml)
        self.assertEqual(xml.count("<downloadRequest>"), 1)

    def test_parse_search_response_namespace_and_uri(self):
        xml = """<?xml version="1.0"?>
        <CMSearchResult xmlns="http://www.hikvision.com/ver20/XMLSchema">
          <responseStatus>true</responseStatus>
          <numOfMatches>1</numOfMatches><totalMatches>1</totalMatches>
          <matchList><searchMatchItem><timeSpan>
            <startTime>2026-09-09T20:10:00Z</startTime>
            <endTime>2026-09-09T20:20:00Z</endTime>
          </timeSpan><mediaSegmentDescriptor>
            <playbackURI>rtsp://dvr/Streaming/tracks/201/?starttime=x&amp;size=123</playbackURI>
          </mediaSegmentDescriptor></searchMatchItem></matchList>
        </CMSearchResult>"""
        result = module.parse_search_response(xml, "201")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["channel"], "201")
        self.assertEqual(result[0]["size"], 123)
        self.assertEqual(result[0]["startTime"], "2026-09-09T20:10:00Z")

    def test_filter_overlaps_strictly(self):
        files = [
            {"startTime": "2026-09-09T20:00:00Z", "endTime": "2026-09-09T20:15:00Z"},
            {"startTime": "2026-09-09T20:15:00Z", "endTime": "2026-09-09T20:30:00Z"},
            {"startTime": "2026-09-09T22:08:00Z", "endTime": "2026-09-09T22:15:00Z"},
        ]
        selected = module.filter_overlapping(files, "2026-09-09T20:15:00Z", "2026-09-09T22:08:00Z")
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["startTime"], "2026-09-09T20:15:00Z")

    def test_title_filename_is_predictable(self):
        self.assertEqual(module.output_filename("灵气闪耀", "2026-09-09"), "灵气闪耀 2026-09-09.mp4")
        with self.assertRaises(ValueError):
            module.output_filename("../bad", "2026-09-09")

    def test_previous_keyframe_preserves_requested_end(self):
        ss, duration = module.expand_for_keyframe(199.0, 198.0, 865.98)
        self.assertEqual(ss, 198.0)
        self.assertAlmostEqual(duration, 866.98, places=2)


if __name__ == "__main__":
    unittest.main()
