"""No GPU/models required: strict loader must never depend on a pointer file."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('clearvoice_infer.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
class StrictLoaderTest(unittest.TestCase):
    def test_missing_pointer_loads_explicit_checkpoint_strictly(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory)/'last_best_checkpoint.pt'
            checkpoint.write_bytes(b'fixture')
            class SpeechModel:
                def load_model(self): raise AssertionError('Upstream pointer discovery must not run')
            torch = Mock()
            torch.load.return_value = {'model': {'module.layer.weight': 7}}
            worker.install_strict_loader(SpeechModel, torch, checkpoint)
            instance = SpeechModel()
            instance.model = Mock()
            instance.load_model()
            self.assertFalse((Path(directory)/'last_best_checkpoint').exists())
            instance.model.load_state_dict.assert_called_once_with({'layer.weight': 7}, strict=True)
            torch.load.assert_called_once_with(checkpoint, map_location='cpu', weights_only=True)
            self.assertTrue(instance._verified_weights_loaded)
    def test_mismatched_weights_abort_and_do_not_claim_loaded(self):
        class SpeechModel: pass
        torch = Mock()
        torch.load.return_value = {'model': {'layer.weight': 7}}
        worker.install_strict_loader(SpeechModel, torch, Path('checkpoint.pt'))
        instance = SpeechModel()
        instance.model = Mock()
        instance.model.load_state_dict.side_effect = RuntimeError('weights mismatch')
        with self.assertRaisesRegex(RuntimeError, 'weights mismatch'): instance.load_model()
        self.assertFalse(instance._verified_weights_loaded)
if __name__ == '__main__': unittest.main()
