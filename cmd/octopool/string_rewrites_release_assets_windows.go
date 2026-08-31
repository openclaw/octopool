package main

import (
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// FILE_BASIC_INFO, as defined by WinBase.h. Access time deliberately excluded
// from the change stamp: reading the file can update it.
type rewriteWindowsBasicInfo struct {
	creationTime, accessTime, writeTime, changeTime int64
	attributes                                      uint32
	padding                                         uint32
}

type rewriteAssetChange struct {
	creationTime, changeTime int64
	attributes               uint32
}

func rewriteReleaseChange(file *os.File, _ os.FileInfo) (rewriteAssetChange, error) {
	var info rewriteWindowsBasicInfo
	err := windows.GetFileInformationByHandleEx(windows.Handle(file.Fd()), windows.FileBasicInfo, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	return rewriteAssetChange{info.creationTime, info.changeTime, info.attributes}, err
}

// Pin every directory without delete sharing before opening its descendant.
// OPEN_REPARSE_POINT applies only to the last component of a CreateFile call.
func openRewriteWindowsPath(path string, directory bool) (*os.File, func(), error) {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if part == ".." {
			return nil, nil, errRewriteBlocked
		}
	}
	absolute, err := filepath.Abs(path)
	if err != nil || !validRewriteFilesystemPath(absolute) {
		return nil, nil, errRewriteBlocked
	}
	volume := filepath.VolumeName(absolute)
	if len(volume) != 2 || volume[1] != ':' {
		return nil, nil, errRewriteBlocked
	}
	current := volume + `\`
	root, err := windows.UTF16PtrFromString(current)
	if err != nil || windows.GetDriveType(root) == windows.DRIVE_REMOTE {
		return nil, nil, errRewriteBlocked
	}
	parts := strings.Split(strings.TrimPrefix(absolute, current), `\`)
	paths := []string{current}
	for _, part := range parts {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		paths = append(paths, current)
	}
	files := []*os.File{}
	closeFiles := func() {
		for i := len(files) - 1; i >= 0; i-- {
			_ = files[i].Close()
		}
	}
	for i, path := range paths {
		isDirectory := i < len(paths)-1 || directory
		access, share := uint32(windows.GENERIC_READ), uint32(windows.FILE_SHARE_READ)
		if isDirectory {
			// Attribute/security-only access does not participate in sharing checks.
			// Directory list access makes omitting FILE_SHARE_DELETE pin the name.
			access, share = windows.FILE_LIST_DIRECTORY|windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE
		}
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			closeFiles()
			return nil, nil, err
		}
		handle, err := windows.CreateFile(name, access, share, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err != nil {
			closeFiles()
			return nil, nil, err
		}
		file := os.NewFile(uintptr(handle), path)
		files = append(files, file)
		var info windows.ByHandleFileInformation
		err = windows.GetFileInformationByHandle(handle, &info)
		kind, typeErr := windows.GetFileType(handle)
		if err != nil || typeErr != nil || kind != windows.FILE_TYPE_DISK || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != isDirectory {
			closeFiles()
			return nil, nil, errRewriteBlocked
		}
	}
	return files[len(files)-1], closeFiles, nil
}

func openRewriteReleaseAsset(path string) (*os.File, func(), error) {
	if !validRewriteReleasePath(path) {
		return nil, nil, errRewriteBlocked
	}
	return openRewriteWindowsPath(path, false)
}

func inspectRewriteReleaseAsset(path string) (string, os.FileInfo, rewriteAssetChange, error) {
	file, closeFile, err := openRewriteReleaseAsset(path)
	if err != nil {
		return "", nil, rewriteAssetChange{}, err
	}
	defer closeFile()
	info, err := file.Stat()
	if err != nil {
		return "", nil, rewriteAssetChange{}, err
	}
	change, err := rewriteReleaseChange(file, info)
	if err != nil {
		return "", nil, rewriteAssetChange{}, err
	}
	// Resolve DOS drive and short-name aliases from the opened handle too.
	// A lexical absolute path alone can hide policy matches behind those aliases.
	buffer := make([]uint16, 32768)
	length, err := windows.GetFinalPathNameByHandle(windows.Handle(file.Fd()), &buffer[0], uint32(len(buffer)), 0)
	if err != nil || length == 0 || length >= uint32(len(buffer)) {
		return "", nil, rewriteAssetChange{}, errRewriteBlocked
	}
	resolved := windows.UTF16ToString(buffer[:length])
	resolved, ok := strings.CutPrefix(resolved, `\\?\`)
	if !ok || len(resolved) < 3 || resolved[1] != ':' || !validRewriteReleasePath(resolved) {
		return "", nil, rewriteAssetChange{}, errRewriteBlocked
	}
	return resolved, info, change, nil
}
