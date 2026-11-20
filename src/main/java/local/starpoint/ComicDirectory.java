package local.starpoint;

import android.content.Context;
import java.io.File;
import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.UUID;

final class ComicDirectory {
    private static final String VIEW_NAME = "offline-comics";
    private static final String SELECTION = "selected";

    static File prepare(Context context) throws IOException {
        File root = new File(context.getFilesDir(), VIEW_NAME);
        Files.createDirectories(root.toPath());
        // Keep COMIC_DIR stable. Swapping one symlink changes both series for the running server.
        for (String kind : new String[]{"0", "1"}) {
            Path entry = root.toPath().resolve(kind);
            Path target = Paths.get(SELECTION, kind);
            try {
                Files.createSymbolicLink(entry, target);
            } catch (FileAlreadyExistsException error) {
                if (!Files.isSymbolicLink(entry) || !Files.readSymbolicLink(entry).equals(target)) {
                    throw new IOException("漫画目录的本地挂载无效。", error);
                }
            }
        }
        return root;
    }

    static String currentSelection(Context context) throws IOException {
        try {
            return Files.readSymbolicLink(selection(context)).toString();
        } catch (NoSuchFileException error) {
            return null;
        }
    }

    static void select(Context context, File folder) throws IOException {
        File selected = folder.getCanonicalFile();
        String cdnLocation = CdnDirectory.savedLocation(context);
        if (cdnLocation != null) {
            Path cdn = new File(cdnLocation, "cn").getCanonicalFile().toPath();
            Path comics = selected.toPath();
            if (comics.startsWith(cdn) || cdn.startsWith(comics)) {
                throw new IOException("请将漫画目录与游戏 CDN 目录分开放置。");
            }
        }
        for (String kind : new String[]{"0", "1"}) {
            String[] entries = new File(selected, kind).list((directory, name) -> name.endsWith(".jpg"));
            if (entries != null && entries.length != 0) {
                File root = prepare(context);
                Path temporary = root.toPath().resolve(".selection-" + UUID.randomUUID());
                try {
                    Files.createSymbolicLink(temporary, selected.toPath());
                    Files.move(temporary, selection(context),
                            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } finally {
                    Files.deleteIfExists(temporary);
                }
                return;
            }
        }
        throw new IOException("未读到漫画。请选择直接包含 0 或 1 文件夹及其 JPG 索引的上一级目录。");
    }

    static void clear(Context context) throws IOException {
        Files.deleteIfExists(selection(context));
    }

    private static Path selection(Context context) {
        return path(context).resolve(SELECTION);
    }

    private static Path path(Context context) {
        return new File(context.getFilesDir(), VIEW_NAME).toPath();
    }
}
